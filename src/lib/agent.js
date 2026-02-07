import { createToolset } from "./tools.js";
import { buildSystemPrompt, formatHistory, parseModelAction } from "./prompt.js";
import { TaskPlanner, TaskExecutor } from "./taskPlanner.js";

export class Agent {
  constructor({ provider, workspaceDir, autoApproveRef, askApproval, onEvent }) {
    this.provider = provider;
    this.workspaceDir = workspaceDir;
    this.autoApproveRef = autoApproveRef;
    this.askApproval = askApproval;
    this.onEvent = onEvent;
    this.history = [];
    this.tools = createToolset({
      workspaceDir,
      autoApproveRef,
      askApproval,
      onToolStart: (tool, input) => this.onEvent?.({ type: "tool_start", tool, input }),
    });
    this.taskPlanner = new TaskPlanner(this);
  }

  clearHistory() {
    this.history = [];
  }

  async runTurn(userMessage) {
    this.history.push({ role: "user", content: userMessage });

    // 首先检查是否需要任务规划
    const shouldPlan = this.shouldPlanTask(userMessage);
    if (shouldPlan) {
      return await this.runPlannedTask(userMessage);
    }

    // 对于简单任务，使用原有的循环方式
    for (let i = 0; i < 12; i += 1) {
      const systemPrompt = buildSystemPrompt({
        workspaceDir: this.workspaceDir,
        autoApprove: this.autoApproveRef.value,
      });

      const prompt = formatHistory(this.history);
      this.onEvent?.({ type: "model_call", provider: this.provider.kind, model: this.provider.model });
      const raw = await this.provider.complete({ systemPrompt, prompt });
      const action = parseModelAction(raw);

      if (action.type === "final") {
        this.history.push({ role: "assistant", content: action.message });
        return action.message;
      }

      if (action.type === "thought") {
        console.log(`[Thinking] ${action.content}`);
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

      const toolCallMessage = {
        type: "tool_use",
        tool: action.tool,
        input: action.input,
        reason: action.reason || "",
      };

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
      try {
        result = await toolFn(action.input || {});
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }

      const toolResultMessage = {
        type: "tool_result",
        tool: action.tool,
        result: result
      };

      this.history.push({
        role: "user",
        content: JSON.stringify(toolResultMessage)
      });
    }

    const fallback = "Stopped after max tool iterations for this turn.";
    this.history.push({ role: "assistant", content: fallback });
    return fallback;
  }

  shouldPlanTask(message) {
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
