/**
 * One-shot script to onboard a new project into Simulacra.
 *
 * Usage:
 *   npx tsx scripts/onboard.ts <project-name> <absolute-path> <crafter-types>
 *
 * Example:
 *   npx tsx scripts/onboard.ts "My App" /abs/path/to/my-app frontend,backend
 *
 * This creates the project registry entry and a project_assignment approval.
 * Start the orchestrator (npm start) and approve the project_assignment in the
 * console — the kickoff flow will begin automatically from there.
 */
import { onboardProject } from "../src/workflow/onboarding.js";

const [, , name, projectPath, crafterTypesArg] = process.argv;

if (!name || !projectPath || !crafterTypesArg) {
  console.error("Usage: npx tsx scripts/onboard.ts <name> <path> <crafter-types>");
  console.error('Example: npx tsx scripts/onboard.ts "My App" /path/to/app frontend,backend');
  process.exit(1);
}

const crafterTypes = crafterTypesArg.split(",").map((s) => s.trim()).filter(Boolean);

const { slug, approvalId } = await onboardProject({
  name,
  path: projectPath,
  crafterTypes,
  requestedBy: "tarantoga",
});

console.log(`Project registered: ${slug}`);
console.log(`Approval ID:        ${approvalId}`);
console.log("");
console.log("Next steps:");
console.log("  1. Run: npm start");
console.log(`  2. Approve the project_assignment (${approvalId}) in the console`);
console.log("  3. The kickoff Council will run automatically");
