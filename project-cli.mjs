import { inspectProject } from "./dashboard/projects.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const roots = args.filter(arg => arg !== "--json");

try {
  if (roots.length > 1 || roots.some(arg => arg.startsWith("--"))) {
    throw new Error("Usage: node project-cli.mjs [root] [--json]");
  }
  const snapshot = await inspectProject(roots[0] ?? process.cwd());
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    const { project, counts } = snapshot;
    console.log(`${project.name} — ${snapshot.root}`);
    console.log("Record validation: valid structure, references and source quotes; not scientific verification or approval.");
    console.log(`Summary: ${project.summary || "[Unknown] No summary recorded; inspect sources and record current coverage when an update is requested."}`);
    console.log(`Next step: ${project.nextStep || "[Unknown] No next action recorded; identify the evidence gap to resolve before proposing an action."}`);
    console.log(`Counts: ${counts.sources} sources, ${counts.concepts} concepts, ${counts.buildUps} BuildUp records, ${counts.gaps} evidence gaps`);
    for (const diagnostic of snapshot.diagnostics) {
      const record = snapshot.buildUps.find(item => item.id === diagnostic.recordId);
      const action = diagnostic.kind === "gap"
        ? ` Read ${record.sourceIds.map(id => snapshot.sources.find(source => source.id === id).path).join(", ") || "relevant project evidence"}; retain [Unknown] until a real supporting quote is available. Do not infer acceptance.`
        : "";
      console.log(`${diagnostic.kind === "gap" ? "Evidence gap" : "Warning"} [${diagnostic.recordId}]: ${diagnostic.message}${action}`);
    }
  }
} catch (error) {
  const message = `${error.message} If the marker is missing, explicitly request strataa-project bootstrap from bounded local evidence; inspection never creates .strataa/project.json.`;
  if (json) console.log(JSON.stringify({ status: "error", error: message }));
  else console.error(`Project inspection failed: ${message}`);
  process.exitCode = 1;
}
