import { createToolset } from "./tools.js";
import { buildSystemPrompt, formatHistory, parseModelAction } from "./prompt.js";
import { TaskPlanner, TaskExecutor } from "./taskPlanner.js";

export class Agent {
  constructor({
    provider,
    workspaceDir,
    autoApproveRef,
    askApproval,
    onEvent,
    activeSkillsRef,
    onTodoWrite,
    projectInstructionsRef,
  }) {
    this.provider = provider;
    this.workspaceDir = workspaceDir;
    this.autoApproveRef = autoApproveRef;
    this.askApproval = askApproval;
    this.onEvent = onEvent;
    this.activeSkillsRef = activeSkillsRef || { value: [] };
    this.projectInstructionsRef = projectInstructionsRef || { value: null };
    this.history = [];
    this.tools = createToolset({
      workspaceDir,
      autoApproveRef,
      askApproval,
      onToolStart: (tool, input) => this.onEvent?.({ type: "tool_start", tool, input }),
      onTodoWrite,
    });
    this.enablePlanner = process.env.PIECODE_ENABLE_PLANNER === "1";
    this.taskPlanner = this.enablePlanner ? new TaskPlanner(this) : null;
    this.planFirstEnabled = process.env.PIECODE_PLAN_FIRST !== "0";
    this.defaultToolBudget = Math.max(
      1,
      Math.min(12, Number.parseInt(process.env.PIECODE_TOOL_BUDGET || "6", 10) || 6)
    );
    this.iterationCheckpoint = Math.max(
      5,
      Number.parseInt(process.env.PIECODE_ITERATION_CHECKPOINT || "20", 10) || 20
    );
  }

  clearHistory() {
    this.history = [];
  }

  getActiveSkills() {
    return Array.isArray(this.activeSkillsRef?.value) ? this.activeSkillsRef.value : [];
  }

  extractFirstJsonObject(text) {
    const source = String(text || "");
    const start = source.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    return null;
  }

  parsePlan(raw) {
    const source = String(raw || "").trim();
    const candidates = [source, this.extractFirstJsonObject(source)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        const steps = Array.isArray(parsed?.steps)
          ? parsed.steps.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
          : [];
        const summary = String(parsed?.summary || "").trim();
        const toolBudgetRaw = Number(parsed?.toolBudget);
        const toolBudget = Number.isFinite(toolBudgetRaw)
          ? Math.max(1, Math.min(12, Math.round(toolBudgetRaw)))
          : this.defaultToolBudget;
        if (!summary && steps.length === 0) continue;
        return { summary: summary || "Execution plan", steps, toolBudget };
      } catch {
        // continue
      }
    }
    return null;
  }

  async planTurn(userMessage) {
    const planSystemPrompt = [
      "You are a planning assistant for a coding agent.",
      "Create a short plan before tool usage.",
      "Output strict JSON only:",
      '{"summary":"...","steps":["..."],"toolBudget":4}',
      "Constraints:",
      "- steps must be concise",
      "- choose minimal toolBudget (1-6 normally)",
      "- avoid shell unless essential",
    ].join("\n");

    const planPrompt = `User request:\n${userMessage}`;
    try {
      this.onEvent?.({ type: "planning_call", provider: this.provider.kind, model: this.provider.model });
      this.onEvent?.({
        type: "llm_request",
        stage: "planning",
        payload: `SYSTEM:\n${planSystemPrompt}\n\nUSER:\n${planPrompt}`,
      });
      const raw = await this.provider.complete({ systemPrompt: planSystemPrompt, prompt: planPrompt });
      this.onEvent?.({ type: "llm_response", stage: "planning", payload: String(raw || "") });
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.onEvent?.({ type: "plan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  async replanTurn({ userMessage, previousPlan, toolCalls }) {
    const replanSystemPrompt = [
      "You are replanning a coding task after partial execution.",
      "Output strict JSON only:",
      '{"summary":"...","steps":["..."],"toolBudget":6}',
      "Requirements:",
      "- Keep plan concise and practical",
      "- Avoid redundant steps already likely completed",
      "- Increase toolBudget only as needed",
    ].join("\n");

    const previousSteps = Array.isArray(previousPlan?.steps) ? previousPlan.steps : [];
    const replanPrompt = [
      `User request:\n${userMessage}`,
      `Previous summary: ${previousPlan?.summary || "-"}`,
      `Previous steps:\n${previousSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "-"}`,
      `Tools already used in this turn: ${toolCalls}`,
      "Create an updated plan for the remaining work.",
    ].join("\n\n");

    try {
      this.onEvent?.({ type: "replanning_call", provider: this.provider.kind, model: this.provider.model });
      this.onEvent?.({
        type: "llm_request",
        stage: "replanning",
        payload: `SYSTEM:\n${replanSystemPrompt}\n\nUSER:\n${replanPrompt}`,
      });
      const raw = await this.provider.complete({ systemPrompt: replanSystemPrompt, prompt: replanPrompt });
      this.onEvent?.({ type: "llm_response", stage: "replanning", payload: String(raw || "") });
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.onEvent?.({ type: "replan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  async runTurn(userMessage) {
    this.history.push({ role: "user", content: userMessage });
    let activePlan = null;

    if (this.planFirstEnabled && !this.enablePlanner) {
      activePlan = await this.planTurn(userMessage);
    }

    // 首先检查是否需要任务规划
    const shouldPlan = this.shouldPlanTask(userMessage);
    if (shouldPlan) {
      return await this.runPlannedTask(userMessage);
    }

    const toolBudget = activePlan?.toolBudget ?? this.defaultToolBudget;
    let toolCalls = 0;
    let budget = toolBudget;
    let didReplan = false;

    // 对于简单任务，使用原有的循环方式
    let i = 0;
    while (true) {
      i += 1;
      if (i % this.iterationCheckpoint === 0) {
        const shouldContinue = await this.askApproval(
          `The agent has run ${i} model iterations in this turn. Continue? [Y/n]: `
        );
        if (!shouldContinue) {
          const msg = `Stopped after ${i} iterations by user choice.`;
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }
      }

      const systemPrompt = buildSystemPrompt({
        workspaceDir: this.workspaceDir,
        autoApprove: this.autoApproveRef.value,
        activeSkills: this.getActiveSkills(),
        activePlan,
        projectInstructions: this.projectInstructionsRef?.value || null,
      });

      const prompt = formatHistory(this.history);
      this.onEvent?.({ type: "model_call", provider: this.provider.kind, model: this.provider.model });
      this.onEvent?.({
        type: "llm_request",
        stage: "turn",
        payload: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${prompt}`,
      });
      const raw = await this.provider.complete({ systemPrompt, prompt });
      this.onEvent?.({ type: "llm_response", stage: "turn", payload: String(raw || "") });
      const action = parseModelAction(raw);

      if (action.type === "final") {
        this.onEvent?.({ type: "thinking_done" });
        this.history.push({ role: "assistant", content: action.message });
        return action.message;
      }

      if (action.type === "thought") {
        this.onEvent?.({ type: "thinking_done" });
        this.onEvent?.({ type: "thought", content: action.content });
        this.history.push({
          role: "assistant",
          content: JSON.stringify({ type: "thought", content: action.content })
        });
        continue;
      }

      const toolFn = this.tools[action.tool];
      if (!toolFn) {
        const msg = `Unknown tool: ${action.tool}`;
        this.history.push({ role: "assistant", content: msg });
        return msg;
      }

      toolCalls += 1;

      const toolCallMessage = {
        type: "tool_use",
        tool: action.tool,
        input: action.input,
        reason: action.reason || "",
      };

      this.onEvent?.({ type: "thinking_done" });
      this.onEvent?.({
        type: "tool_use",
        tool: action.tool,
        reason: action.reason || "",
        input: action.input
      });

      this.history.push({
        role: "assistant",
        content: JSON.stringify(toolCallMessage)
      });

      let result;
      let toolError = null;
      try {
        result = await toolFn(action.input || {});
      } catch (err) {
        result = `Tool error: ${err.message}`;
        toolError = err.message;
      }

      this.onEvent?.({
        type: "tool_end",
        tool: action.tool,
        result: String(result || ""),
        error: toolError,
      });

      const toolResultMessage = {
        type: "tool_result",
        tool: action.tool,
        result: result
      };

      this.history.push({
        role: "user",
        content: JSON.stringify(toolResultMessage)
      });

      if (activePlan && toolCalls >= budget && !didReplan) {
        const newPlan = await this.replanTurn({
          userMessage,
          previousPlan: activePlan,
          toolCalls,
        });
        if (newPlan) {
          activePlan = newPlan;
          budget = Math.max(newPlan.toolBudget || budget, budget + 1);
          didReplan = true;
          this.onEvent?.({
            type: "plan_progress",
            message: `Replanned after ${toolCalls} tools. New budget: ${budget}`,
          });
        }
      }
    }

    const fallback = "Stopped after max tool iterations for this turn.";
    this.history.push({ role: "assistant", content: fallback });
    return fallback;
  }

  shouldPlanTask(message) {
    if (!this.enablePlanner) return false;

    const messageLower = message.toLowerCase();

    // 如果消息包含以下特征，可能需要任务规划
    const hasComplexTaskKeywords = [
      'analyze', 'implement', 'refactor', 'debug', 'test',
      'build', 'create', 'design', 'develop', 'improve',
      'fix', 'optimize', 'restructure', 'update'
    ].some(keyword => messageLower.includes(keyword));

    const hasMultiStepIndicators = [
      'first', 'then', 'next', 'after that', 'finally',
      'step 1', 'step 2', 'step 3', '1.', '2.', '3.'
    ].some(indicator => messageLower.includes(indicator));

    const isLongMessage = message.length > 100;

    return hasComplexTaskKeywords || hasMultiStepIndicators || isLongMessage;
  }

  async runPlannedTask(userMessage) {
    if (!this.taskPlanner) {
      throw new Error("Task planner is not enabled.");
    }
    console.log('[Planning] Analyzing task requirements...');
    const analysis = await this.taskPlanner.analyzeTask(userMessage);

    console.log(`[Planning] Task type: ${analysis.taskType}`);
    console.log(`[Planning] Difficulty: ${analysis.difficulty}`);
    console.log(`[Planning] Sub-tasks: ${analysis.subTasks.length}`);

    if (analysis.challenges.length > 0) {
      console.log(`[Planning] Potential challenges: ${analysis.challenges.join(', ')}`);
    }

    // 创建执行计划
    console.log('[Planning] Creating execution plan...');
    const plan = await this.taskPlanner.createExecutionPlan(analysis);

    console.log(`[Planning] Plan created with ${plan.length} steps.`);
    plan.forEach((step, index) => {
      console.log(`[Step ${index + 1}] ${step.description}`);
    });

    // 执行计划
    const executor = new TaskExecutor(this, plan);
    console.log('[Execution] Starting task execution...');
    const results = await executor.executePlan();

    // 分析结果
    const successfulSteps = results.filter(r => r.success);
    const failedSteps = results.filter(r => !r.success);

    console.log(`[Execution] Completed ${successfulSteps.length}/${results.length} steps successfully`);

    if (failedSteps.length > 0) {
      console.log(`[Execution] Failed steps: ${failedSteps.map(r => r.step.id).join(', ')}`);
      failedSteps.forEach(stepResult => {
        console.log(`[Step ${stepResult.step.id}] Error: ${stepResult.error}`);
      });
    }

    // 收集详细结果
    const detailedResults = [];
    results.forEach(result => {
      const stepResult = {
        step: result.step.description,
        status: result.success ? 'Success' : 'Failed',
        id: result.step.id,
        result: result.success ? result.result : result.error
      };
      detailedResults.push(stepResult);
    });

    // 分析结果并生成总结
    const taskOutcome = this.analyzeTaskOutcome(results);

    // 创建详细的结果字符串
    let resultStr = `✅ Task Completed - ${analysis.taskType}\n`;
    resultStr += `📊 Difficulty: ${analysis.difficulty}\n`;
    resultStr += `🎯 Goal: ${analysis.goal}\n`;
    resultStr += `\n📝 Execution Summary: ${taskOutcome.summary}\n`;

    resultStr += `\n📋 Steps: (${detailedResults.length} total)\n`;
    detailedResults.forEach(stepResult => {
      const icon = stepResult.status === 'Success' ? '✅' : (stepResult.status === 'Failed' ? '❌' : '⚠️');
      resultStr += `  ${icon} ${stepResult.step}\n`;

      if (stepResult.status === 'Failed') {
        resultStr += `    Error: ${stepResult.result}\n`;
      } else if (stepResult.status === 'Skipped') {
        resultStr += `    Note: ${stepResult.result}\n`;
      }
    });

    if (taskOutcome.recommendations.length > 0) {
      resultStr += `\n💡 Recommendations: ${taskOutcome.recommendations.length}\n`;
      taskOutcome.recommendations.forEach((rec, index) => {
        resultStr += `  ${index + 1}. ${rec}\n`;
      });
    }

    // 在历史中记录任务完成情况
    this.history.push({
      role: "assistant",
      content: `Task completed with ${successfulSteps.length}/${results.length} steps successfully`
    });

    return resultStr;
  }

  analyzeTaskOutcome(results) {
    const successfulSteps = results.filter(r => r.success);
    const failedSteps = results.filter(r => !r.success);
    const completionRate = successfulSteps.length / results.length;

    let summary = `Task completed with ${successfulSteps.length}/${results.length} steps (${Math.round(completionRate * 100)}% success rate). `;

    if (failedSteps.length === 0) {
      summary += 'All steps were executed successfully.';
    } else if (failedSteps.length <= 2) {
      summary += `${failedSteps.length} minor issues were encountered, but most steps were successful.`;
    } else {
      summary += `${failedSteps.length} steps failed. The task may need to be re-executed with modifications.`;
    }

    const recommendations = [];
    if (failedSteps.length > 0) {
      recommendations.push('Review the failed steps and try again');
    }
    if (completionRate < 0.8) {
      recommendations.push('Consider simplifying the task or breaking it into smaller sub-tasks');
    }
    recommendations.push('Check if there are any dependencies or prerequisites that need to be met');

    return {
      summary,
      recommendations,
      completionRate
    };
  }
}
