import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 任务类型枚举
 */
export const TaskType = {
  ANALYSIS: 'analysis',
  DEBUGGING: 'debugging',
  IMPLEMENTATION: 'implementation',
  REFACTORING: 'refactoring',
  TESTING: 'testing',
  DOCUMENTATION: 'documentation',
  OTHER: 'other'
};

/**
 * 任务难度级别
 */
export const TaskDifficulty = {
  SIMPLE: 'simple',
  MEDIUM: 'medium',
  COMPLEX: 'complex'
};

/**
 * 任务步骤
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
    // 这会在Agent中实现
    throw new Error('TaskStep.execute() must be implemented');
  }
}

/**
 * 任务规划器
 */
export class TaskPlanner {
  constructor(agent) {
    this.agent = agent;
  }

  async analyzeTask(description) {
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

Your analysis should follow these principles (from Claude Code):
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
    {"id": "step2", "description": "second sub-task"},
    {"id": "step3", "description": "third sub-task"}
  ],
  "requiredTools": ["shell", "read_file", "write_file", "list_files"],
  "challenges": ["potential challenge 1", "potential challenge 2"]
}`,
      prompt: `Analyze the task: "${description}"`
    });

    try {
      const parsed = JSON.parse(analysis);
      return parsed;
    } catch (error) {
      console.error('Error parsing task analysis:', error);
      return this.getDefaultAnalysis(description);
    }
  }

  getDefaultAnalysis(description) {
    const hasKeywords = (keywords) => {
      const desc = description.toLowerCase();
      return keywords.some(keyword => desc.includes(keyword.toLowerCase()));
    };

    let taskType = TaskType.OTHER;
    let difficulty = TaskDifficulty.MEDIUM;
    let subTasks = [];
    let requiredTools = [];

    if (hasKeywords(['analyze', 'review', 'inspect', 'examine', 'audit', 'evaluate'])) {
      taskType = TaskType.ANALYSIS;
      subTasks = [
        { id: 'analyze-code', description: 'Analyze the current codebase structure and files' },
        { id: 'identify-issues', description: 'Identify potential issues or areas for improvement' },
        { id: 'review-architecture', description: 'Review code architecture and design patterns' },
        { id: 'generate-report', description: 'Generate analysis report with findings' }
      ];
      requiredTools = ['shell', 'read_file', 'list_files'];
    } else if (hasKeywords(['debug', 'fix', 'error', 'bug', 'troubleshoot', 'resolve'])) {
      taskType = TaskType.DEBUGGING;
      subTasks = [
        { id: 'reproduce-error', description: 'Reproduce the error scenario' },
        { id: 'locate-bug', description: 'Locate the bug in the codebase' },
        { id: 'fix-bug', description: 'Implement a fix for the bug' },
        { id: 'test-fix', description: 'Test the fix to ensure it works' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file'];
    } else if (hasKeywords(['implement', 'add', 'create', 'build', 'develop', 'feature', 'functionality'])) {
      taskType = TaskType.IMPLEMENTATION;
      subTasks = [
        { id: 'analyze-requirements', description: 'Analyze task requirements' },
        { id: 'design-solution', description: 'Design the implementation approach' },
        { id: 'write-code', description: 'Write the implementation code' },
        { id: 'test-code', description: 'Test the implementation' },
        { id: 'document', description: 'Document the implementation' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file', 'list_files'];
    } else if (hasKeywords(['refactor', 'improve', 'optimize', 'restructure', 'rewrite'])) {
      taskType = TaskType.REFACTORING;
      subTasks = [
        { id: 'analyze-current', description: 'Analyze current implementation' },
        { id: 'identify-issues', description: 'Identify issues and optimization opportunities' },
        { id: 'implement-refactor', description: 'Implement refactoring changes' },
        { id: 'test-changes', description: 'Test the refactored code' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file'];
    } else if (hasKeywords(['test', 'verify', 'check', 'validate', 'coverage'])) {
      taskType = TaskType.TESTING;
      subTasks = [
        { id: 'run-tests', description: 'Run existing tests' },
        { id: 'analyze-coverage', description: 'Analyze test coverage' },
        { id: 'add-tests', description: 'Add new tests if needed' },
        { id: 'fix-failing', description: 'Fix failing tests' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file'];
    } else if (hasKeywords(['document', 'comment', 'writeup', 'readme', 'docs'])) {
      taskType = TaskType.DOCUMENTATION;
      subTasks = [
        { id: 'review-code', description: 'Review the codebase' },
        { id: 'write-docs', description: 'Write documentation' },
        { id: 'verify-docs', description: 'Verify documentation accuracy' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file'];
    } else {
      taskType = TaskType.OTHER;
      difficulty = TaskDifficulty.SIMPLE;
      subTasks = [
        { id: 'execute-task', description: 'Execute the requested task' }
      ];
      requiredTools = ['shell', 'read_file', 'write_file', 'list_files'];
    }

    return {
      type: 'analysis_result',
      taskType,
      difficulty,
      goal: description,
      subTasks,
      requiredTools,
      challenges: []
    };
  }

  async createExecutionPlan(taskAnalysis) {
    const plan = [];
    const taskType = taskAnalysis.taskType;

    switch (taskType) {
      case TaskType.ANALYSIS:
        plan.push(...this.createAnalysisPlan(taskAnalysis));
        break;
      case TaskType.DEBUGGING:
        plan.push(...this.createDebuggingPlan(taskAnalysis));
        break;
      case TaskType.IMPLEMENTATION:
        plan.push(...this.createImplementationPlan(taskAnalysis));
        break;
      case TaskType.REFACTORING:
        plan.push(...this.createRefactoringPlan(taskAnalysis));
        break;
      case TaskType.TESTING:
        plan.push(...this.createTestingPlan(taskAnalysis));
        break;
      case TaskType.DOCUMENTATION:
        plan.push(...this.createDocumentationPlan(taskAnalysis));
        break;
      default:
        plan.push(...this.createDefaultPlan(taskAnalysis));
    }

    return plan;
  }

  createAnalysisPlan(taskAnalysis) {
    return [
      new TaskStep('analyze-code', 'Analyze current directory structure', 'list_files', {
        path: '.',
        max_entries: 20
      }),
      new TaskStep('read-package', 'Read package.json and project metadata', 'read_file', {
        path: 'package.json'
      }),
      new TaskStep('read-readme', 'Read project documentation', 'read_file', {
        path: 'README.md'
      }),
      new TaskStep('check-src-structure', 'Check source code structure', 'list_files', {
        path: 'src'
      })
    ];
  }

  createDebuggingPlan(taskAnalysis) {
    return [
      new TaskStep('check-files', 'Check relevant files in project', 'shell', {
        command: 'ls -la'
      }),
      new TaskStep('run-tests', 'Run existing tests if available', 'shell', {
        command: 'npm test -- --watchAll=false'
      }),
      new TaskStep('check-git-status', 'Check git status and changes', 'shell', {
        command: 'git status && git diff'
      }),
      new TaskStep('identify-problem', 'Identify potential problem areas', 'shell', {
        command: 'grep -r "TODO\\|FIXME\\|BUG" . --include="*.js" --include="*.ts" --include="*.json" | head -20'
      })
    ];
  }

  createImplementationPlan(taskAnalysis) {
    return [
      new TaskStep('check-files', 'Check current project structure', 'shell', {
        command: 'ls -la'
      }),
      new TaskStep('read-package', 'Read package.json dependencies and scripts', 'read_file', {
        path: 'package.json'
      }),
      new TaskStep('check-config', 'Check project configuration files', 'list_files', {
        path: '.'
      }),
      new TaskStep('read-source', 'Read existing source files', 'shell', {
        command: 'find src -name "*.js" -o -name "*.ts" -o -name "*.json" | head -10'
      })
    ];
  }

  createRefactoringPlan(taskAnalysis) {
    return [
      new TaskStep('analyze-code', 'Analyze current code structure', 'shell', {
        command: 'ls -la src/'
      }),
      new TaskStep('check-quality', 'Check existing code quality tools', 'read_file', {
        path: 'package.json'
      }),
      new TaskStep('run-linting', 'Run linting if available', 'shell', {
        command: 'npm run lint'
      }),
      new TaskStep('run-tests', 'Run existing tests', 'shell', {
        command: 'npm test -- --watchAll=false'
      })
    ];
  }

  createTestingPlan(taskAnalysis) {
    return [
      new TaskStep('run-tests', 'Run existing test suite', 'shell', {
        command: 'npm test -- --watchAll=false'
      }),
      new TaskStep('check-coverage', 'Check test coverage if available', 'shell', {
        command: 'npm run test:coverage'
      }),
      new TaskStep('check-test-files', 'Check test file structure', 'list_files', {
        path: 'test'
      }),
      new TaskStep('analyze-coverage', 'Analyze coverage reports', 'shell', {
        command: 'cat coverage/lcov-report/index.html 2>/dev/null || echo "No coverage report found"'
      })
    ];
  }

  createDocumentationPlan(taskAnalysis) {
    return [
      new TaskStep('check-docs', 'Check existing documentation files', 'shell', {
        command: 'find . -name "*.md" -o -name "*.rst" -o -name "*.txt" | grep -v node_modules | head -20'
      }),
      new TaskStep('read-readme', 'Read project README', 'read_file', {
        path: 'README.md'
      }),
      new TaskStep('check-code-docs', 'Check if code has comments or JSDoc', 'shell', {
        command: 'grep -r "/\\*\\*" src --include="*.js" --include="*.ts" | head -10'
      })
    ];
  }

  createDefaultPlan(taskAnalysis) {
    return [
      new TaskStep('execute-task', 'Execute the requested task', 'shell', {
        command: 'echo "Task execution started. Please provide more specific instructions for detailed processing."'
      })
    ];
  }
}

/**
 * 任务执行器
 */
export class TaskExecutor {
  constructor(agent, plan) {
    this.agent = agent;
    this.plan = plan;
    this.currentStep = 0;
  }

  async executePlan() {
    const results = [];

    for (let i = 0; i < this.plan.length; i++) {
      const step = this.plan[i];
      console.log(`[Task] Step ${i + 1}/${this.plan.length}: ${step.description}`);

      try {
        // 检查依赖项是否已完成
        const dependencies = step.dependencies || [];
        const allDependenciesMet = dependencies.every(depId => {
          return results.some(result => result.step.id === depId && result.success);
        });

        if (!allDependenciesMet) {
          console.log(`[Task] Skipping step ${step.id} - dependencies not met`);
          results.push({
            step,
            success: false,
            result: 'Dependencies not met',
            error: 'Dependencies not met'
          });
          continue;
        }

        // 执行步骤
        await this.executeStep(step);
        results.push({
          step,
          success: true,
          result: step.result
        });

      } catch (error) {
        console.error(`[Task] Step ${step.id} failed:`, error);
        results.push({
          step,
          success: false,
          result: null,
          error: error.message
        });

        // 对于关键步骤失败，可能需要停止
        if (this.isCriticalStep(step)) {
          console.log('[Task] Critical step failed, stopping execution');
          break;
        }
      }
    }

    return results;
  }

  isCriticalStep(step) {
    const criticalKeywords = [
      'install', 'setup', 'configure', 'remove', 'delete', 'rm', 'mv',
      'npm install', 'npm uninstall', 'git reset', 'git push', 'git pull',
      'sudo', 'chmod', 'chown', 'rm -rf', 'force', 'overwrite', 'destroy',
      'drop', 'truncate', 'erase', 'format', 'init', 'clone', 'fetch'
    ];
    return criticalKeywords.some(keyword =>
      step.description.toLowerCase().includes(keyword.toLowerCase()) ||
      (step.input?.command && step.input.command.toLowerCase().includes(keyword.toLowerCase()))
    );
  }

  async executeStep(step) {
    // 更新步骤状态
    step.status = 'running';

    try {
      // 检查是否是关键步骤
      if (this.isCriticalStep(step)) {
        console.log(`[Task] Step ${step.id} is critical and requires approval - skipping`);
        step.status = 'skipped';
        step.result = 'Critical step requires user approval - skipped';
        return step.result;
      }

      // 执行步骤
      if (step.tool === 'shell') {
        // 检查是否有自动批准
        if (this.agent.autoApproveRef.value) {
          step.result = await this.agent.tools.shell(step.input);
        } else {
          // 如果需要用户批准，跳过这个步骤
          console.log(`[Task] Step ${step.id} requires user approval - skipping`);
          step.status = 'skipped';
          step.result = 'Requires user approval - skipped';
          return step.result;
        }
      } else if (step.tool === 'read_file') {
        step.result = await this.agent.tools.read_file(step.input);
      } else if (step.tool === 'write_file') {
        step.result = await this.agent.tools.write_file(step.input);
      } else if (step.tool === 'list_files') {
        step.result = await this.agent.tools.list_files(step.input);
      } else {
        throw new Error(`Unknown tool: ${step.tool}`);
      }

      step.status = 'completed';
      return step.result;

    } catch (error) {
      console.warn(`[Task] Step ${step.id} failed: ${error.message}`);

      // 如果是 readline 错误，尝试跳过
      if (error.code === 'ERR_USE_AFTER_CLOSE' ||
          error.message.includes('readline') ||
          error.message.includes('closed')) {
        console.log(`[Task] Step ${step.id} failed due to readline issues - skipping`);
        step.status = 'skipped';
        step.result = 'Readline error - skipped';
        return step.result;
      }

      step.status = 'failed';
      throw error;
    }
  }
}
