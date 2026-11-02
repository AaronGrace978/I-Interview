import { spawn } from "node:child_process";
import electron from "electron";
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, INTERVIEW_DEV: "1", ELECTRON_RUN_AS_NODE: "" },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
