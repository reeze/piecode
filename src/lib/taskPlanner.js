/**
 * Task type enum
 */
export const TaskType = {
  ANALYSIS: 'analysis',
  DEBUGGING: 'debugging',
  IMPLEMENTATION: 'implementation',
  REFACTORING: 'refactoring',
  TESTING: 'testing',
  DOCUMENTATION: 'documentation',
  OTHER: 'other',
};

/**
 * Task difficulty enum
 */
export const TaskDifficulty = {
  SIMPLE: 'simple',
  MEDIUM: 'medium',
  COMPLEX: 'complex',
};

const DEFAULT_TEST_COMMAND = 'npm test -- --watchAll=false';

const TASK_PROFILES = [
  {
    type: TaskType.ANALYSIS,
    difficulty: TaskDifficulty.MEDIUM,
    keywords: ['analyze', 'analyse', 'review', 'inspect', 'examine', 'audit', 'evaluate'],
    subTasks: [
      { id: 'analyze-code', description: 'Analyze the current codebase structure and files' },
      { id: 'identify-issues', description: 'Identify potential issues or areas for improvement' },
      { id: 'review-architecture', description: 'Review code architecture and design patterns' },
      { id: 'generate-report', description: 'Generate analysis report with findings' },
    ],
    requiredTools: ['list_files', 'read_file', 'search_files'],
  },
  {
    type: TaskType.DEBUGGING,
    difficulty: TaskDifficulty.MEDIUM,
    keywords: ['debug', 'fix', 'error', 'bug', 'troubleshoot', 'resolve'],
    subTasks: [
      { id: 'reproduce-error', description: 'Inspect failing behavior' },
      { id: 'locate-bug', description: 'Locate the bug in the codebase' },
      { id: 'fix-bug', description: 'Implement a fix for the bug' },
      { id: 'test-fix', description: 'Test the fix to ensure it works' },
    ],
    requiredTools: ['git_status', 'search_files', 'run_tests'],
  },
  {
    type: TaskType.IMPLEMENTATION,
    difficulty: TaskDifficulty.MEDIUM,
    keywords: ['implement', 'add', 'create', 'build', 'develop', 'feature', 'functionality'],
    subTasks: [
      { id: 'analyze-requirements', description: 'Analyze task requirements' },
      { id: 'design-solution', description: 'Design the implementation approach' },
      { id: 'write-code', description: 'Write the implementation code' },
      { id: 'test-code', description: 'Test the implementation' },
      { id: 'document', description: 'Document the implementation' },
    ],
    requiredTools: ['list_files', 'read_file', 'glob_files'],
  },
  {
    type: TaskType.REFACTORING,
    difficulty: TaskDifficulty.MEDIUM,
    keywords: ['refactor', 'improve', 'optimize', 'restructure', 'rewrite'],
    subTasks: [
      { id: 'analyze-current', description: 'Analyze current implementation' },
      { id: 'identify-issues', description: 'Identify issues and optimization opportunities' },
      { id: 'implement-refactor', description: 'Implement refactoring changes' },
      { id: 'test-changes', description: 'Test the refactored code' },
    ],
    requiredTools: ['list_files', 'read_file', 'run_tests'],
  },
  {
    type: TaskType.TESTING,
    difficulty: TaskDifficulty.MEDIUM,
    keywords: ['test', 'verify', 'check', 'validate', 'coverage'],
    subTasks: [
      { id: 'run-tests', description: 'Run existing tests' },
      { id: 'analyze-coverage', description: 'Analyze test coverage' },
      { id: 'add-tests', description: 'Add new tests if needed' },
      { id: 'fix-failing', description: 'Fix failing tests' },
    ],
    requiredTools: ['run_tests', 'list_files', 'find_files'],
  },
  {
    type: TaskType.DOCUMENTATION,
    difficulty: TaskDifficulty.SIMPLE,
    keywords: ['document', 'comment', 'writeup', 'readme', 'docs'],
    subTasks: [
      { id: 'review-code', description: 'Review the codebase' },
      { id: 'write-docs', description: 'Write documentation' },
      { id: 'verify-docs', description: 'Verify documentation accuracy' },
    ],
    requiredTools: ['glob_files', 'read_file', 'search_files'],
  },
];

/**
 * Task step
 */
export class TaskStep {
  constructor(id, description, tool, input = {}, dependencies = []) {
    this.id = id;
    this.description = description;
    this.tool = tool;
    this.input = input;
    this.dependencies = dependencies;
    this.status = 'pending';
    this.result = null;
  }

  async execute() {
    throw new Error('TaskStep.execute() must be implemented');
  }
}

/**
 * Task planner
 */
export class TaskPlanner {
  constructor(agent) {
    this.agent = agent;
  }

  createStep(id, description, tool, input = {}, dependencies = []) {
    return new TaskStep(id, description, tool, input, dependencies);
  }

  async analyzeTask(description) {
    const heuristic = this.getDefaultAnalysis(description);
    if (!this.shouldRefineAnalysis(description, heuristic)) {
      return heuristic;
    }

    const analysis = await this.agent.provider.complete({
      systemPrompt: `You are a task analyzer. Your job is to analyze software engineering tasks and determine:
1. The task type (analysis, debugging, implementation, refactoring, testing, documentation, other)
2. The difficulty level (simple, medium, complex)
3. The main goal of the task
4. Key sub-tasks that need to be completed
5. Required tools and resources
6. Potential challenges or obstacles

Please think through your analysis step by step. Consider:
- What is the user actually asking for?
- What are the core requirements?
- What existing resources might be relevant?
- What potential challenges could arise?
- What's the most efficient way to approach this task?

Your analysis should follow these principles:
- Keep solutions simple and focused
- Avoid over-engineering
- Maintain existing coding style
- Don't make changes beyond what's requested
- Be concise and actionable
- Test changes before providing final answers

Analyze the following task:
"${description}"

Respond with JSON in this format:
{
  "type": "analysis_result",
  "taskType": "analysis|debugging|implementation|refactoring|testing|documentation|other",
  "difficulty": "simple|medium|complex",
  "goal": "main task objective",
  "subTasks": [
    {"id": "step1", "description": "first sub-task"},
    {"id": "step2", "description": "second sub-task"}
  ],
  "requiredTools": ["read_file", "list_files", "search_files", "run_tests"],
  "challenges": ["potential challenge 1", "potential challenge 2"]
}`,
      prompt: `Analyze the task: "${description}"`,
    });

    try {
      return this.normalizeAnalysisResult(JSON.parse(analysis), heuristic);
    } catch (error) {
      console.error('Error parsing task analysis:', error);
      return heuristic;
    }
  }

  shouldRefineAnalysis(description, heuristic) {
    const text = String(description || '').trim();
    if (!text) return false;
    if (heuristic.taskType === TaskType.OTHER) return true;
    if (text.length >= 220) return true;

    const lower = text.toLowerCase();
    const matchedTypes = TASK_PROFILES.filter((profile) =>
      profile.keywords.some((keyword) => lower.includes(keyword))
    );

    if (matchedTypes.length >= 2) return true;
    if (/\b(first|then|next|after that|finally|step\s+\d+)\b/.test(lower)) return true;
    return false;
  }

  normalizeAnalysisResult(raw, fallback) {
    const allowedTypes = new Set(Object.values(TaskType));
    const allowedDifficulty = new Set(Object.values(TaskDifficulty));
    const safeFallback = fallback || this.getDefaultAnalysis('');

    if (!raw || typeof raw !== 'object') {
      return safeFallback;
    }

    const taskType = allowedTypes.has(raw.taskType) ? raw.taskType : safeFallback.taskType;
    const difficulty = allowedDifficulty.has(raw.difficulty) ? raw.difficulty : safeFallback.difficulty;
    const goal = String(raw.goal || safeFallback.goal || '').trim() || safeFallback.goal;
    const subTasks = Array.isArray(raw.subTasks) && raw.subTasks.length > 0
      ? raw.subTasks
          .map((step, index) => {
            if (!step || typeof step !== 'object') return null;
            const description = String(step.description || '').trim();
            if (!description) return null;
            return {
              id: String(step.id || `step${index + 1}`),
              description,
            };
          })
          .filter(Boolean)
      : safeFallback.subTasks;
    const requiredTools = Array.isArray(raw.requiredTools) && raw.requiredTools.length > 0
      ? raw.requiredTools.map((tool) => String(tool || '').trim()).filter(Boolean)
      : safeFallback.requiredTools;
    const challenges = Array.isArray(raw.challenges)
      ? raw.challenges.map((item) => String(item || '').trim()).filter(Boolean)
      : safeFallback.challenges;

    return {
      type: 'analysis_result',
      taskType,
      difficulty,
      goal,
      subTasks,
      requiredTools,
      challenges,
    };
  }

  getDefaultAnalysis(description) {
    const desc = String(description || '').toLowerCase();
    const scoredProfiles = TASK_PROFILES
      .map((profile) => ({
        profile,
        score: profile.keywords.reduce((count, keyword) => count + (desc.includes(keyword) ? 1 : 0), 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const selectedProfile = scoredProfiles[0]?.profile || null;
    const taskType = selectedProfile?.type || TaskType.OTHER;
    const difficulty = selectedProfile?.difficulty || TaskDifficulty.SIMPLE;
    const subTasks = selectedProfile?.subTasks || [{ id: 'execute-task', description: 'Execute the requested task' }];
    const requiredTools = selectedProfile?.requiredTools || ['list_files', 'read_file'];

    return {
      type: 'analysis_result',
      taskType,
      difficulty,
      goal: description,
      subTasks,
      requiredTools,
      challenges: [],
    };
  }

  async createExecutionPlan(taskAnalysis) {
    const plan = [];
    const taskType = taskAnalysis.taskType;

    switch (taskType) {
      case TaskType.ANALYSIS:
        plan.push(...this.createAnalysisPlan());
        break;
      case TaskType.DEBUGGING:
        plan.push(...this.createDebuggingPlan());
        break;
      case TaskType.IMPLEMENTATION:
        plan.push(...this.createImplementationPlan());
        break;
      case TaskType.REFACTORING:
        plan.push(...this.createRefactoringPlan());
        break;
      case TaskType.TESTING:
        plan.push(...this.createTestingPlan());
        break;
      case TaskType.DOCUMENTATION:
        plan.push(...this.createDocumentationPlan());
        break;
      default:
        plan.push(...this.createDefaultPlan());
    }

    return plan;
  }

  createAnalysisPlan() {
    return [
      this.createStep('analyze-code', 'Analyze current directory structure', 'list_files', {
        path: '.',
        max_entries: 40,
      }),
      this.createStep('read-package', 'Read package.json and project metadata', 'read_file', {
        path: 'package.json',
      }),
      this.createStep('read-readme', 'Read project documentation', 'read_file', {
        path: 'README.md',
      }),
      this.createStep('check-src-structure', 'Check source code structure', 'list_files', {
        path: 'src',
        max_entries: 80,
      }),
    ];
  }

  createDebuggingPlan() {
    return [
      this.createStep('check-git-status', 'Check git status and current changes', 'git_status', {
        porcelain: false,
      }),
      this.createStep('run-tests', 'Run existing tests if available', 'run_tests', {
        command: DEFAULT_TEST_COMMAND,
        timeout_ms: 120000,
      }),
      this.createStep('identify-problem', 'Find bug markers and error handling hotspots', 'search_files', {
        path: 'src',
        regex: 'TODO|FIXME|BUG|throw new Error|catch\\s*\\(',
        file_pattern: '*.js',
        max_results: 40,
      }),
      this.createStep('inspect-diff', 'Review current diff for suspicious changes', 'git_diff', {
        context: 3,
      }),
    ];
  }

  createImplementationPlan() {
    return [
      this.createStep('check-files', 'Check current project structure', 'list_files', {
        path: '.',
        max_entries: 60,
      }),
      this.createStep('read-package', 'Read package.json dependencies and scripts', 'read_file', {
        path: 'package.json',
      }),
      this.createStep('check-config', 'Check top-level project configuration files', 'glob_files', {
        path: '.',
        pattern: '*.json',
        max_results: 20,
      }),
      this.createStep('read-source', 'Inspect existing source files', 'glob_files', {
        path: 'src',
        pattern: '**/*',
        max_results: 30,
      }),
    ];
  }

  createRefactoringPlan() {
    return [
      this.createStep('analyze-code', 'Analyze current code structure', 'list_files', {
        path: 'src',
        max_entries: 80,
      }),
      this.createStep('check-quality', 'Check existing code quality tools', 'read_file', {
        path: 'package.json',
      }),
      this.createStep('run-linting', 'Run linting if available', 'run_tests', {
        command: 'npm run lint',
        timeout_ms: 120000,
      }),
      this.createStep('run-tests', 'Run existing tests', 'run_tests', {
        command: DEFAULT_TEST_COMMAND,
        timeout_ms: 120000,
      }),
    ];
  }

  createTestingPlan() {
    return [
      this.createStep('run-tests', 'Run existing test suite', 'run_tests', {
        command: DEFAULT_TEST_COMMAND,
        timeout_ms: 120000,
      }),
      this.createStep('check-coverage', 'Check test coverage if available', 'run_tests', {
        command: 'npm run test:coverage',
        timeout_ms: 180000,
      }),
      this.createStep('check-test-files', 'Check test file structure', 'list_files', {
        path: '__tests__',
        max_entries: 80,
      }),
      this.createStep('analyze-coverage', 'Locate coverage-related artifacts', 'find_files', {
        path: '.',
        query: 'coverage',
        max_results: 20,
      }),
    ];
  }

  createDocumentationPlan() {
    return [
      this.createStep('check-docs', 'Check existing documentation files', 'glob_files', {
        path: '.',
        pattern: '**/*.md',
        max_results: 40,
      }),
      this.createStep('read-readme', 'Read project README', 'read_file', {
        path: 'README.md',
      }),
      this.createStep('check-code-docs', 'Check if code has comments or JSDoc', 'search_files', {
        path: 'src',
        regex: '/\\*\\*',
        file_pattern: '*.js',
        max_results: 20,
      }),
    ];
  }

  createDefaultPlan() {
    return [
      this.createStep('inspect-workspace', 'Inspect workspace structure', 'list_files', {
        path: '.',
        max_entries: 40,
      }),
      this.createStep('inspect-package', 'Read package metadata when available', 'read_file', {
        path: 'package.json',
      }),
    ];
  }
}

/**
 * Task executor
 */
export class TaskExecutor {
  constructor(agent, plan, hooks = {}) {
    this.agent = agent;
    this.plan = plan;
    this.currentStep = 0;
    this.hooks = hooks && typeof hooks === "object" ? hooks : {};
  }

  log(message) {
    if (typeof this.hooks.onLog === "function") {
      this.hooks.onLog(message);
      return;
    }
    console.log(message);
  }

  warn(message, error = null) {
    if (typeof this.hooks.onWarn === "function") {
      this.hooks.onWarn(message, error);
      return;
    }
    console.warn(message, error || "");
  }

  error(message, error = null) {
    if (typeof this.hooks.onError === "function") {
      this.hooks.onError(message, error);
      return;
    }
    console.error(message, error || "");
  }

  async executePlan() {
    const results = [];

    for (let i = 0; i < this.plan.length; i += 1) {
      const step = this.plan[i];
      this.currentStep = i;
      this.log(`[Task] Step ${i + 1}/${this.plan.length}: ${step.description}`);
      this.hooks.onStepStart?.(step, { index: i, total: this.plan.length });

      try {
        const dependencies = step.dependencies || [];
        const allDependenciesMet = dependencies.every((depId) => {
          return results.some((result) => result.step.id === depId && result.success);
        });

        if (!allDependenciesMet) {
          this.log(`[Task] Skipping step ${step.id} - dependencies not met`);
          results.push({
            step,
            success: false,
            result: 'Dependencies not met',
            error: 'Dependencies not met',
          });
          this.hooks.onStepEnd?.(step, {
            index: i,
            total: this.plan.length,
            success: false,
            result: 'Dependencies not met',
            error: 'Dependencies not met',
          });
          continue;
        }

        await this.executeStep(step);
        const skipped = step.status === 'skipped';
        results.push({
          step,
          success: !skipped,
          result: step.result,
          skipped,
        });
        this.hooks.onStepEnd?.(step, {
          index: i,
          total: this.plan.length,
          success: !skipped,
          result: step.result,
          error: skipped ? step.result : null,
        });
      } catch (error) {
        this.error(`[Task] Step ${step.id} failed:`, error);
        results.push({
          step,
          success: false,
          result: null,
          error: error.message,
        });
        this.hooks.onStepEnd?.(step, {
          index: i,
          total: this.plan.length,
          success: false,
          result: null,
          error: error.message,
        });

        if (this.isCriticalStep(step)) {
          this.log('[Task] Critical step failed, stopping execution');
          break;
        }
      }
    }

    return results;
  }

  isCriticalStep(step) {
    const criticalKeywords = [
      'install', 'remove', 'delete', 'rm', 'mv', 'reset', 'push', 'pull',
      'sudo', 'chmod', 'chown', 'overwrite', 'destroy', 'drop', 'truncate',
    ];
    const description = String(step?.description || '').toLowerCase();
    const command = String(step?.input?.command || '').toLowerCase();
    const tool = String(step?.tool || '').toLowerCase();
    if (['write_file', 'edit_file', 'replace_in_files', 'apply_patch'].includes(tool)) return true;
    return criticalKeywords.some((keyword) => description.includes(keyword) || command.includes(keyword));
  }

  async executeStep(step) {
    step.status = 'running';

    try {
      if (this.isCriticalStep(step)) {
        this.log(`[Task] Step ${step.id} is critical and requires approval - skipping`);
        step.status = 'skipped';
        step.result = 'Critical step requires user approval - skipped';
        return step.result;
      }

      const toolFn = this.agent.tools?.[step.tool];
      if (typeof toolFn !== 'function') {
        throw new Error(`Unknown tool: ${step.tool}`);
      }

      if (step.tool === 'shell' && !this.agent.autoApproveRef.value) {
        this.log(`[Task] Step ${step.id} requires user approval - skipping`);
        step.status = 'skipped';
        step.result = 'Requires user approval - skipped';
        return step.result;
      }

      step.result = await toolFn(step.input);
      step.status = 'completed';
      this.agent.onEvent?.({
        type: "tool_end",
        tool: step.tool,
        result: String(step.result || ""),
        error: null,
      });
      return step.result;
    } catch (error) {
      this.warn(`[Task] Step ${step.id} failed: ${error.message}`);

      if (
        error.code === 'ERR_USE_AFTER_CLOSE' ||
        error.message.includes('readline') ||
        error.message.includes('closed')
      ) {
        this.log(`[Task] Step ${step.id} failed due to readline issues - skipping`);
        step.status = 'skipped';
        step.result = 'Readline error - skipped';
        return step.result;
      }

      step.status = 'failed';
      this.agent.onEvent?.({
        type: "tool_end",
        tool: step.tool,
        result: String(step.result || ""),
        error: error.message,
      });
      throw error;
    }
  }
}
