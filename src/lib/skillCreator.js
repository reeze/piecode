import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Default skill root directory
const DEFAULT_SKILL_DIR = path.join(os.homedir(), ".agents", "skills");

// Validate skill name
function validateSkillName(name) {
  const normalized = String(name || "").trim();
  if (!normalized) return { valid: false, message: "Skill name cannot be empty" };
  if (normalized.length < 2) return { valid: false, message: "Skill name must be at least 2 characters" };
  if (normalized.length > 50) return { valid: false, message: "Skill name must be less than 50 characters" };
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return { valid: false, message: "Skill name can only contain letters, numbers, ., _, and -" };
  }
  return { valid: true, message: "" };
}

// Validate description
function validateDescription(description) {
  const normalized = String(description || "").trim();
  if (!normalized) return { valid: false, message: "Description cannot be empty" };
  if (normalized.length < 10) return { valid: false, message: "Description should be at least 10 characters" };
  if (normalized.length > 200) return { valid: false, message: "Description should be less than 200 characters" };
  return { valid: true, message: "" };
}

// Validate content
function validateContent(content) {
  const normalized = String(content || "").trim();
  if (!normalized) return { valid: false, message: "Skill content cannot be empty" };
  if (normalized.length < 50) return { valid: false, message: "Skill content should be at least 50 characters" };
  return { valid: true, message: "" };
}

// Generate SKILL.md content
function generateSkillContent(name, description, content) {
  return `# ${name}

${description}

${content}`;
}

// Check if skill already exists
async function skillExists(name, skillRoots) {
  for (const root of skillRoots) {
    const skillDir = path.join(root, name);
    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      await fs.access(skillFile);
      return true;
    } catch {
      // File doesn't exist, continue to check other roots
    }
  }
  return false;
}

// Create skill directory and file
async function createSkill(name, description, content, skillRoots) {
  // Try to create in first valid root
  for (const root of skillRoots) {
    try {
      // Ensure root directory exists
      await fs.mkdir(root, { recursive: true });
      
      const skillDir = path.join(root, name);
      const skillFile = path.join(skillDir, "SKILL.md");
      
      // Create skill directory
      await fs.mkdir(skillDir, { recursive: true });
      
      // Write SKILL.md file
      await fs.writeFile(skillFile, generateSkillContent(name, description, content), "utf8");
      
      return { success: true, path: skillFile };
    } catch (err) {
      // Try next root if this one fails
      console.error(`Warning: Failed to create skill in ${root}: ${err.message}`);
    }
  }
  
  return { success: false, error: "Failed to create skill in any of the skill directories. Check permissions and try again." };
}

// Interactive skill creation
async function createSkillInteractive(rl, skillRoots) {
  console.log("=== Skill Creator ===");
  console.log("Create a new coding agent skill. Skills are reusable instructions stored as SKILL.md files.");
  console.log("");

  // 1. Get skill name
  let name;
  while (true) {
    name = (await rl.question("Skill name: ")).trim();
    const validation = validateSkillName(name);
    if (!validation.valid) {
      console.log(`❌ ${validation.message}`);
      continue;
    }
    
    if (await skillExists(name, skillRoots)) {
      console.log(`❌ Skill '${name}' already exists. Please choose a different name.`);
      continue;
    }
    
    break;
  }

  console.log("");

  // 2. Get description
  let description;
  while (true) {
    description = (await rl.question("Short description: ")).trim();
    const validation = validateDescription(description);
    if (!validation.valid) {
      console.log(`❌ ${validation.message}`);
      continue;
    }
    break;
  }

  console.log("");
  console.log("Skill content (instructions for the coding agent):");
  console.log("- Describe how the agent should behave when this skill is active");
  console.log("- Include examples of tasks the agent can help with");
  console.log("- Press Enter twice to finish (or write '/done' on a new line)");
  console.log("");

  // 3. Get content
  let content = "";
  while (true) {
    const line = await rl.question("");
    if (line === "/done") break;
    if (line === "" && content) break; // Two empty lines
    content += line + "\n";
  }

  const validation = validateContent(content);
  if (!validation.valid) {
    console.log(`❌ ${validation.message}`);
    return null;
  }

  console.log("");

  // 4. Confirmation
  console.log("Skill Summary:");
  console.log(`Name:        ${name}`);
  console.log(`Description: ${description}`);
  console.log(`Content:     ${content.length} characters`);
  console.log("");

  const confirm = (await rl.question("Create this skill? (y/n): ")).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    console.log("Skill creation canceled.");
    return null;
  }

  // 5. Create skill
  console.log("");
  console.log(`Creating skill '${name}'...`);
  const result = await createSkill(name, description, content.trim(), skillRoots);
  
  if (result.success) {
    console.log(`✅ Skill created successfully at:`);
    console.log(`   ${result.path}`);
    console.log("");
    console.log(`Use '/skills use ${name}' to enable this skill.`);
    return result.path;
  } else {
    console.log(`❌ Failed to create skill: ${result.error}`);
    return null;
  }
}

// Quick skill creation from template
async function createSkillFromTemplate(name, description, content, skillRoots) {
  const validationName = validateSkillName(name);
  if (!validationName.valid) {
    return { success: false, error: validationName.message };
  }

  const validationDesc = validateDescription(description);
  if (!validationDesc.valid) {
    return { success: false, error: validationDesc.message };
  }

  const validationContent = validateContent(content);
  if (!validationContent.valid) {
    return { success: false, error: validationContent.message };
  }

  if (await skillExists(name, skillRoots)) {
    return { success: false, error: `Skill '${name}' already exists` };
  }

  return await createSkill(name, description, content, skillRoots);
}

export {
  createSkillInteractive,
  createSkillFromTemplate,
  validateSkillName,
  validateDescription,
  validateContent,
  DEFAULT_SKILL_DIR
};
