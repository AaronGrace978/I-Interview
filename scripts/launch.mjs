import { spawn } from "node:child_process";
import electron from "electron";
const env = { ...process.env, INTERVIEW_DEV: "1" };
// Electron treats any presence of this variable as "run as Node", including "".
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
