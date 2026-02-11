import { jest } from '@jest/globals';

// Mock fs before importing skills module
const mockReadFile = jest.fn();
jest.unstable_mockModule('node:fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    readFile: mockReadFile,
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocking
const {
  parseFrontmatter,
  extractTriggers,
  extractSkillNamesFromInstructions,
  autoLoadSkillsFromInstructions,
  findTriggeredSkills,
  findMentionedSkills,
  autoEnableSkills,
} = await import('../src/lib/skills.js');

describe('Skills trigger system', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue('# Skill content');
  });

  describe('parseFrontmatter', () => {
    test('parses simple YAML frontmatter', () => {
      const content = `---
name: test-skill
description: Test skill
---

# Body content`;

      const result = parseFrontmatter(content);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        description: 'Test skill',
      });
      expect(result.body).toBe('# Body content');
    });

    test('parses frontmatter with arrays', () => {
      const content = `---
triggers:
  - react
  - next.js
  - component
---

# Body`;

      const result = parseFrontmatter(content);
      expect(result.frontmatter.triggers).toEqual(['react', 'next.js', 'component']);
    });

    test('parses frontmatter with nested objects', () => {
      const content = `---
metadata:
  author: test
  version: "1.0.0"
---

# Body`;

      const result = parseFrontmatter(content);
      expect(result.frontmatter.metadata).toEqual({
        author: 'test',
        version: '1.0.0',
      });
    });

    test('handles content without frontmatter', () => {
      const content = '# Just a header\n\nSome content';
      const result = parseFrontmatter(content);
      expect(result.frontmatter).toEqual({});
      expect(result.body).toBe(content);
    });

    test('parses vercel-react-best-practices style frontmatter', () => {
      const content = `---
name: vercel-react-best-practices
description: React and Next.js performance optimization guidelines from Vercel Engineering
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
triggers:
  - react
  - next.js
  - performance
---

# Vercel React Best Practices

## When to Apply
- Writing new React components
- Optimizing bundle size
`;

      const result = parseFrontmatter(content);
      expect(result.frontmatter.name).toBe('vercel-react-best-practices');
      expect(result.frontmatter.license).toBe('MIT');
      expect(result.frontmatter.metadata.author).toBe('vercel');
      expect(result.frontmatter.triggers).toEqual(['react', 'next.js', 'performance']);
    });
  });

  describe('extractTriggers', () => {
    test('extracts triggers from frontmatter array', () => {
      const frontmatter = { triggers: ['react', 'next.js'] };
      const body = '';
      expect(extractTriggers(frontmatter, body)).toEqual(['react', 'next.js']);
    });

    test('extracts triggers from frontmatter string', () => {
      const frontmatter = { triggers: 'react, next.js, component' };
      const body = '';
      expect(extractTriggers(frontmatter, body)).toEqual(['react', 'next.js', 'component']);
    });

    test('extracts triggers from "When to Apply" section', () => {
      const frontmatter = {};
      const body = `## When to Apply
- frontend development
- ui design

## Other section`;
      expect(extractTriggers(frontmatter, body)).toEqual(['frontend development', 'ui design']);
    });

    test('extracts triggers from "Triggers" section', () => {
      const frontmatter = {};
      const body = `## Triggers
- react components
- next.js pages`;
      expect(extractTriggers(frontmatter, body)).toEqual(['react components', 'next.js pages']);
    });

    test('combines triggers from frontmatter and body', () => {
      const frontmatter = { triggers: ['react'] };
      const body = `## Triggers
- next.js`;
      expect(extractTriggers(frontmatter, body)).toEqual(['react', 'next.js']);
    });

    test('returns lowercase triggers', () => {
      const frontmatter = { triggers: ['React', 'NEXT.JS'] };
      expect(extractTriggers(frontmatter, '')).toEqual(['react', 'next.js']);
    });

    test('deduplicates triggers from frontmatter and body', () => {
      const frontmatter = { triggers: ['react'] };
      const body = `## When to Apply
- react
- next.js`;
      const triggers = extractTriggers(frontmatter, body);
      expect(triggers.filter(t => t === 'react')).toHaveLength(1);
      expect(triggers).toContain('react');
      expect(triggers).toContain('next.js');
    });
  });

  describe('findTriggeredSkills', () => {
    test('finds skills matching single-word triggers', () => {
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          triggers: ['react', 'component'],
        }],
      ]);

      const matches = findTriggeredSkills('Help me with React', skillIndex, []);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('react-skill');
    });

    test('finds skills matching multi-word triggers', () => {
      const skillIndex = new Map([
        ['ui-skill', {
          name: 'ui-skill',
          triggers: ['ui development'],
        }],
      ]);

      const matches = findTriggeredSkills('I need help with ui development', skillIndex, []);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('ui-skill');
    });

    test('ignores already active skills', () => {
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          triggers: ['react'],
        }],
      ]);

      const activeSkills = [{ name: 'react-skill' }];
      const matches = findTriggeredSkills('React help', skillIndex, activeSkills);
      expect(matches).toHaveLength(0);
    });

    test('is case insensitive', () => {
      const skillIndex = new Map([
        ['skill', { name: 'skill', triggers: ['react'] }],
      ]);

      const matches = findTriggeredSkills('REACT', skillIndex, []);
      expect(matches).toHaveLength(1);
    });

    test('uses word boundaries for single-word triggers', () => {
      const skillIndex = new Map([
        ['react-skill', { name: 'react-skill', triggers: ['react'] }],
      ]);

      // Should NOT match "reaction" because "react" is part of a larger word
      const matches = findTriggeredSkills('This is a reaction', skillIndex, []);
      expect(matches).toHaveLength(0);

      // Should match "react" as a standalone word
      const matches2 = findTriggeredSkills('Use React library', skillIndex, []);
      expect(matches2).toHaveLength(1);
    });

    test('matches multiple skills with different triggers', () => {
      const skillIndex = new Map([
        ['react-skill', { name: 'react-skill', triggers: ['react'] }],
        ['vue-skill', { name: 'vue-skill', triggers: ['vue'] }],
        ['frontend-skill', { name: 'frontend-skill', triggers: ['react', 'vue'] }],
      ]);

      const matches = findTriggeredSkills('Help with React and Vue', skillIndex, []);
      expect(matches).toHaveLength(3);
      const names = matches.map(m => m.name);
      expect(names).toContain('react-skill');
      expect(names).toContain('vue-skill');
      expect(names).toContain('frontend-skill');
    });

    test('real-world scenario: vercel-react-best-practices triggers', () => {
      const skillIndex = new Map([
        ['vercel-react-best-practices', {
          name: 'vercel-react-best-practices',
          triggers: ['react', 'next.js', 'performance', 'bundle optimization', 'writing new react components'],
        }],
      ]);

      // Should match on "optimize this React component"
      const matches1 = findTriggeredSkills('optimize this React component', skillIndex, []);
      expect(matches1).toHaveLength(1);

      // Should match on "next.js performance"
      const matches2 = findTriggeredSkills('improve next.js performance', skillIndex, []);
      expect(matches2).toHaveLength(1);

      // Should match on multi-word trigger
      const matches3 = findTriggeredSkills('bundle optimization for my app', skillIndex, []);
      expect(matches3).toHaveLength(1);
    });
  });

  describe('findMentionedSkills', () => {
    test('finds skills mentioned with $ prefix', () => {
      const skillIndex = new Map([
        ['my-skill', { name: 'my-skill', path: '/skills/my-skill/SKILL.md' }],
      ]);

      const matches = findMentionedSkills('Use $my-skill to help', skillIndex, []);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('my-skill');
    });

    test('ignores already active skills', () => {
      const skillIndex = new Map([
        ['my-skill', { name: 'my-skill', path: '/skills/my-skill/SKILL.md' }],
      ]);

      const activeSkills = [{ name: 'my-skill' }];
      const matches = findMentionedSkills('Use $my-skill', skillIndex, activeSkills);
      expect(matches).toHaveLength(0);
    });

    test('ignores unknown skills', () => {
      const skillIndex = new Map([]);
      const matches = findMentionedSkills('Use $unknown-skill', skillIndex, []);
      expect(matches).toHaveLength(0);
    });

    test('finds multiple mentioned skills', () => {
      const skillIndex = new Map([
        ['skill-a', { name: 'skill-a', path: '/skills/skill-a/SKILL.md' }],
        ['skill-b', { name: 'skill-b', path: '/skills/skill-b/SKILL.md' }],
      ]);

      const matches = findMentionedSkills('Use $skill-a and $skill-b together', skillIndex, []);
      expect(matches).toHaveLength(2);
    });

    test('handles skill names with dots and hyphens', () => {
      const skillIndex = new Map([
        ['vercel-react-best-practices', { name: 'vercel-react-best-practices', path: '/skills/v/SKILL.md' }],
      ]);

      const matches = findMentionedSkills('Apply $vercel-react-best-practices', skillIndex, []);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('vercel-react-best-practices');
    });
  });

  describe('autoEnableSkills', () => {
    test('enables skills by trigger and returns correct categorization', async () => {
      mockReadFile.mockResolvedValue('# React skill content');
      
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          path: '/skills/react/SKILL.md',
          description: 'React skill',
          triggers: ['react'],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Help with React', activeSkillsRef, skillIndex);

      expect(result.enabled).toContain('react-skill');
      expect(result.byTrigger).toContain('react-skill');
      expect(result.byMention).toHaveLength(0);
      expect(activeSkillsRef.value).toHaveLength(1);
    });

    test('enables skills by mention and returns correct categorization', async () => {
      mockReadFile.mockResolvedValue('# Vue skill content');
      
      const skillIndex = new Map([
        ['vue-skill', {
          name: 'vue-skill',
          path: '/skills/vue/SKILL.md',
          description: 'Vue skill',
          triggers: [],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Use $vue-skill', activeSkillsRef, skillIndex);

      expect(result.enabled).toContain('vue-skill');
      expect(result.byTrigger).toHaveLength(0);
      expect(result.byMention).toContain('vue-skill');
    });

    test('enables both triggered and mentioned skills', async () => {
      mockReadFile
        .mockResolvedValueOnce('# React skill content')
        .mockResolvedValueOnce('# Vue skill content');
      
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          path: '/skills/react/SKILL.md',
          description: 'React skill',
          triggers: ['react'],
        }],
        ['vue-skill', {
          name: 'vue-skill',
          path: '/skills/vue/SKILL.md',
          description: 'Vue skill',
          triggers: [],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Help with React and $vue-skill', activeSkillsRef, skillIndex);

      expect(result.enabled).toHaveLength(2);
      expect(result.enabled).toContain('react-skill');
      expect(result.enabled).toContain('vue-skill');
      expect(result.byTrigger).toContain('react-skill');
      expect(result.byMention).toContain('vue-skill');
    });

    test('does not duplicate already active skills', async () => {
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          path: '/skills/react/SKILL.md',
          description: 'React skill',
          triggers: ['react'],
        }],
      ]);

      const activeSkillsRef = { 
        value: [{ name: 'react-skill', path: '/skills/react/SKILL.md', description: 'React skill' }] 
      };
      const result = await autoEnableSkills('Help with React', activeSkillsRef, skillIndex);

      expect(result.enabled).toHaveLength(0);
      expect(activeSkillsRef.value).toHaveLength(1);
    });

    test('handles empty skill index', async () => {
      const skillIndex = new Map([]);
      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Help with React', activeSkillsRef, skillIndex);

      expect(result.enabled).toHaveLength(0);
      expect(result.byTrigger).toHaveLength(0);
      expect(result.byMention).toHaveLength(0);
    });

    test('handles input with no matching triggers or mentions', async () => {
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          path: '/skills/react/SKILL.md',
          description: 'React skill',
          triggers: ['react'],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Help with Python', activeSkillsRef, skillIndex);

      expect(result.enabled).toHaveLength(0);
    });

    test('real-world scenario: auto-triggers react skill on component task', async () => {
      mockReadFile.mockResolvedValue('# Vercel React Best Practices content');
      
      // Simulates the vercel-react-best-practices skill
      const skillIndex = new Map([
        ['vercel-react-best-practices', {
          name: 'vercel-react-best-practices',
          path: '/skills/vercel-react-best-practices/SKILL.md',
          description: 'React and Next.js performance optimization guidelines',
          triggers: ['react', 'next.js', 'performance', 'bundle optimization', 'component'],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills(
        'optimize this React component for better performance',
        activeSkillsRef,
        skillIndex
      );

      expect(result.enabled).toContain('vercel-react-best-practices');
      expect(result.byTrigger).toContain('vercel-react-best-practices');
      expect(activeSkillsRef.value).toHaveLength(1);
    });

    test('handles file read errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));
      
      const skillIndex = new Map([
        ['react-skill', {
          name: 'react-skill',
          path: '/skills/react/SKILL.md',
          description: 'React skill',
          triggers: ['react'],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoEnableSkills('Help with React', activeSkillsRef, skillIndex);

      // Should not crash, but also not add the skill since file read failed
      expect(result.enabled).toHaveLength(0);
      expect(activeSkillsRef.value).toHaveLength(0);
    });
  });

  describe('instruction-based auto-load', () => {
    test('extracts skill names from AGENTS available skills section', () => {
      const instructions = `
## Skills
### Available skills
- comicbook-gen: A skill which help to generate comic book
- vercel-react-best-practices: React and Next.js performance optimization guidelines
### How to use skills
- something else
`;
      const names = extractSkillNamesFromInstructions(instructions);
      expect(names).toEqual(['comicbook-gen', 'vercel-react-best-practices']);
    });

    test('auto-loads listed skills from project instructions', async () => {
      mockReadFile
        .mockResolvedValueOnce('# comicbook-gen skill body')
        .mockResolvedValueOnce('# vercel-react-best-practices skill body');

      const skillIndex = new Map([
        ['comicbook-gen', {
          name: 'comicbook-gen',
          path: '/skills/comicbook-gen/SKILL.md',
          description: 'comic helper',
          triggers: [],
        }],
        ['vercel-react-best-practices', {
          name: 'vercel-react-best-practices',
          path: '/skills/vercel-react-best-practices/SKILL.md',
          description: 'react performance helper',
          triggers: ['react'],
        }],
      ]);

      const activeSkillsRef = { value: [] };
      const result = await autoLoadSkillsFromInstructions(
        {
          content: `
## Skills
### Available skills
- comicbook-gen: comic stuff
- vercel-react-best-practices: react stuff
`,
        },
        activeSkillsRef,
        skillIndex
      );

      expect(result.enabled).toEqual(['comicbook-gen', 'vercel-react-best-practices']);
      expect(result.missing).toEqual([]);
      expect(activeSkillsRef.value).toHaveLength(2);
    });
  });
});
