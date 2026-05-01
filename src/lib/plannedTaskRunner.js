import { TaskExecutor } from "./taskPlanner.js";

export function shouldPlanTaskMessage(message, enabled) {
  if (!enabled) return false;

  const messageLower = String(message || "").toLowerCase();
  const hasComplexTaskKeywords = [
    "analyze",
    "implement",
    "refactor",
    "debug",
    "test",
    "build",
    "create",
    "design",
    "develop",
    "improve",
    "fix",
    "optimize",
    "restructure",
    "update",
  ].some((keyword) => messageLower.includes(keyword));

  const hasMultiStepIndicators = [
    "first",
    "then",
    "next",
    "after that",
    "finally",
    "step 1",
    "step 2",
    "step 3",
    "1.",
    "2.",
    "3.",
  ].some((indicator) => messageLower.includes(indicator));

  const isLongMessage = String(message || "").length > 100;
  return hasComplexTaskKeywords || hasMultiStepIndicators || isLongMessage;
}

export class PlannedTaskRunner {
  constructor(agent, userMessage) {
    this.agent = agent;
    this.userMessage = userMessage;
  }

  emitPlanProgress(message) {
    this.agent.onEvent?.({ type: "plan_progress", message: String(message || "") });
  }

  log(message) {
    this.emitPlanProgress(message);
  }

  analyzeTaskOutcome(results) {
    const successfulSteps = results.filter((r) => r.success);
    const failedSteps = results.filter((r) => !r.success);
    const completionRate = successfulSteps.length / results.length;

    let summary = `Task completed with ${successfulSteps.length}/${results.length} steps (${Math.round(completionRate * 100)}% success rate). `;

    if (failedSteps.length === 0) {
      summary += "All steps were executed successfully.";
    } else if (failedSteps.length <= 2) {
      summary += `${failedSteps.length} minor issues were encountered, but most steps were successful.`;
    } else {
      summary += `${failedSteps.length} steps failed. The task may need to be re-executed with modifications.`;
    }

    const recommendations = [];
    if (failedSteps.length > 0) {
      recommendations.push("Review the failed steps and try again");
    }
    if (completionRate < 0.8) {
      recommendations.push("Consider simplifying the task or breaking it into smaller sub-tasks");
    }
    recommendations.push("Check if there are any dependencies or prerequisites that need to be met");

    return {
      summary,
      recommendations,
      completionRate,
    };
  }

  formatResults({ analysis, results, taskOutcome }) {
    const successfulSteps = results.filter((r) => r.success);
    const detailedResults = results.map((result) => ({
      step: result.step.description,
      status: result.skipped ? "Skipped" : result.success ? "Success" : "Failed",
      id: result.step.id,
      result: result.success ? result.result : result.error,
    }));

    let resultStr = `Task Completed - ${analysis.taskType}\n`;
    resultStr += `Difficulty: ${analysis.difficulty}\n`;
    resultStr += `Goal: ${analysis.goal}\n`;
    resultStr += `\nExecution Summary: ${taskOutcome.summary}\n`;
    resultStr += `\nSteps: (${detailedResults.length} total)\n`;

    detailedResults.forEach((stepResult) => {
      const marker = stepResult.status === "Success" ? "[ok]" : stepResult.status === "Failed" ? "[failed]" : "[note]";
      resultStr += `  ${marker} ${stepResult.step}\n`;
      if (stepResult.status === "Failed") {
        resultStr += `    Error: ${stepResult.result}\n`;
      } else if (stepResult.status === "Skipped") {
        resultStr += `    Note: ${stepResult.result}\n`;
      }
    });

    if (taskOutcome.recommendations.length > 0) {
      resultStr += `\nRecommendations: ${taskOutcome.recommendations.length}\n`;
      taskOutcome.recommendations.forEach((rec, index) => {
        resultStr += `  ${index + 1}. ${rec}\n`;
      });
    }

    this.agent.history.push({
      role: "assistant",
      content: `Task completed with ${successfulSteps.length}/${results.length} steps successfully`,
    });

    return resultStr;
  }

  async run() {
    if (!this.agent.taskPlanner) {
      throw new Error("Task planner is not enabled.");
    }

    this.log("[Planning] Analyzing task requirements...");
    const analysis = await this.agent.taskPlanner.analyzeTask(this.userMessage);

    this.log(`[Planning] Task type: ${analysis.taskType}`);
    this.log(`[Planning] Difficulty: ${analysis.difficulty}`);
    this.log(`[Planning] Sub-tasks: ${analysis.subTasks.length}`);

    if (analysis.challenges.length > 0) {
      this.log(`[Planning] Potential challenges: ${analysis.challenges.join(", ")}`);
    }

    this.log("[Planning] Creating execution plan...");
    const plan = await this.agent.taskPlanner.createExecutionPlan(analysis);
    this.agent.onEvent?.({
      type: "plan",
      plan: {
        summary: `Planner execution for ${analysis.taskType}`,
        steps: plan.map((step) => step.description),
        toolBudget: plan.length,
      },
    });
    this.log(`[Planning] Plan created with ${plan.length} steps.`);
    plan.forEach((step, index) => {
      this.log(`[Step ${index + 1}] ${step.description}`);
    });

    const executor = new TaskExecutor(this.agent, plan, {
      onLog: (message) => this.emitPlanProgress(message),
      onWarn: (message) => this.emitPlanProgress(message),
      onError: (message) => this.emitPlanProgress(message),
      onStepStart: (step, meta) => {
        this.emitPlanProgress(`[Execution] Step ${meta.index + 1}/${meta.total}: ${step.description}`);
      },
      onStepEnd: (step, meta) => {
        const status = meta.success ? "ok" : "failed";
        const suffix = meta.error ? ` (${meta.error})` : "";
        this.emitPlanProgress(`[Execution] Step ${meta.index + 1}/${meta.total} ${status}: ${step.description}${suffix}`);
      },
    });
    this.log("[Execution] Starting task execution...");
    const results = await executor.executePlan();

    const successfulSteps = results.filter((r) => r.success);
    const failedSteps = results.filter((r) => !r.success);

    this.log(`[Execution] Completed ${successfulSteps.length}/${results.length} steps successfully`);
    if (failedSteps.length > 0) {
      this.log(`[Execution] Failed steps: ${failedSteps.map((r) => r.step.id).join(", ")}`);
      failedSteps.forEach((stepResult) => {
        this.log(`[Step ${stepResult.step.id}] Error: ${stepResult.error}`);
      });
    }

    const taskOutcome = this.analyzeTaskOutcome(results);
    return this.formatResults({ analysis, results, taskOutcome });
  }
}
