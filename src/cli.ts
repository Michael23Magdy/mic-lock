import { Command, CommanderError } from "commander";
import { acquireAction } from "./commands/acquire.js";
import { releaseAction } from "./commands/release.js";
import { approveAction } from "./commands/approve.js";
import { withAction } from "./commands/with.js";
import { statusAction } from "./commands/status.js";
import { watchAction } from "./commands/watch.js";
import { queueAction } from "./commands/queue.js";
import { verifyAction } from "./commands/verify.js";
import { gcAction } from "./commands/gc.js";
import { listAction } from "./commands/list.js";
import { discoverAction } from "./commands/discover.js";
import {
  configListAction,
  configRegisterAction,
  configSetDefaultsAction,
} from "./commands/config.js";
import { renewAction } from "./commands/renew.js";
import { setupAction } from "./commands/setup.js";
import { uninstallAction } from "./commands/uninstall.js";
import { guardAction } from "./commands/guard.js";
import { hammerAction } from "./commands/hammer.js";
import { MicLockError } from "./util/errors.js";
import { ExitCode } from "./util/exitcodes.js";
import { errline, emitJson, color } from "./commands/shared.js";

const VERSION = "0.1.0";

/** Options shared by every command, so they work after the subcommand name. */
function common(cmd: Command): Command {
  return cmd
    .option("--json", "machine-readable JSON output")
    .option("--state-dir <path>", "shared state directory (default: ~/.mic-lock)")
    .option("--no-notify", "disable desktop notifications / terminal bell")
    .option("-q, --quiet", "less output")
    .option("--verbose", "more output");
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("mic-lock")
    .description(
      "Local, serverless lock for shared test devices (emulators/simulators/phones) across concurrent agents.",
    )
    .version(VERSION, "-v, --version")
    .showHelpAfterError();

  common(program.command("acquire <resource>"))
    .description("Acquire a lock on a device (joins a fair FIFO queue when busy)")
    .option("-w, --wait", "wait in line until granted instead of failing fast")
    .option("-t, --timeout <ms>", "give up waiting after this many ms")
    .option("--until-approved", "hold until a human runs `approve` (never auto-releases)")
    .option("--ttl <sec>", "dead-man timer: auto-reclaim after N seconds if not renewed")
    .option("--capacity <n>", "if creating: number of interchangeable slots (semaphore)")
    .option("--devices <id...>", "if creating: device ids forming a pool")
    .option("--owner <label>", "who holds it, for `status` (short task description; or set $MIC_LOCK_OWNER)")
    .action(acquireAction);

  common(program.command("release <resource>"))
    .description("Release a lock you hold (or force-release someone else's)")
    .option("--token <fence>", "release the holder with this fence token")
    .option("--slot <id>", "release a specific slot")
    .option("--owner <label>", "release holders matching this owner label")
    .option("-f, --force", "force-release regardless of owner (steal)")
    .option("--reason <text>", "note recorded with a forced release")
    .action(releaseAction);

  common(program.command("approve <resource>"))
    .description("Approve an until-approved hold as the human, releasing it for the next agent")
    .option("--slot <id>", "approve a specific slot")
    .action(approveAction);

  common(program.command("renew <resource>"))
    .description("Extend the dead-man timer on a lock you hold (--ttl acquires)")
    .requiredOption("--token <fence>", "your fence token")
    .action(renewAction);

  common(program.command("with <resource> [command...]"))
    .description("Acquire, run a command while heartbeating, then auto-release (crash-safe)")
    .option("--no-wait", "fail fast instead of waiting in line")
    .option("-t, --timeout <ms>", "give up waiting after this many ms")
    .option("--until-approved", "on success, keep held for human approval instead of releasing")
    .option("--ttl <sec>", "lease seconds before a heartbeat must renew")
    .option("--owner <label>", "who holds it, for `status` (short task description; or set $MIC_LOCK_OWNER)")
    .action(withAction);

  common(program.command("status [resource]"))
    .description("Show holders, wait queues and pending approvals")
    .option("-w, --watch", "live-updating view")
    .option("-a, --all", "all resources (default when no resource given)")
    .action(statusAction);

  common(program.command("watch [resource]"))
    .description("Stream lock events as they happen")
    .option("--events <types>", "comma-separated event types to include")
    .action(watchAction);

  common(program.command("queue <resource>"))
    .description("Show the FIFO wait queue for a resource")
    .action(queueAction);

  common(program.command("verify <resource>"))
    .description("Assert a fence token still owns the lock (exit 12 if superseded)")
    .requiredOption("--token <fence>", "the fence token to verify")
    .action(verifyAction);

  common(program.command("gc [resource]"))
    .description("Reclaim stale locks, prune dead waiters, remove old tombstones")
    .action(gcAction);

  common(program.command("list"))
    .description("List registered resources (and optionally discovered devices)")
    .option("-d, --devices", "also list discovered devices")
    .option("-r, --resources", "only list resources")
    .action(listAction);

  common(program.command("discover"))
    .description("Discover Android/iOS devices and show their lock state")
    .option("--adb", "only probe Android (adb)")
    .option("--simctl", "only probe iOS (xcrun simctl)")
    .action(discoverAction);

  common(program.command("setup"))
    .description("Install & forget: skill + enforcement hook + device-lock rule for agents")
    .option("--project [dir]", "install into a repo's .claude/ (committable, travels); default: cwd")
    .option("--user", "install into ~/.claude/ (all projects on this machine) [default]")
    .option("--print", "dry run: show what would change without writing")
    .action(setupAction);

  common(program.command("uninstall"))
    .aliases(["disable", "remove", "teardown"])
    .description("Reverse `setup`: remove the skill, guard hook & rule, and purge lock state")
    .option("--project [dir]", "uninstall from a repo's .claude/ (default: cwd)")
    .option("--user", "uninstall from ~/.claude/ (all projects on this machine) [default]")
    .option("--print", "dry run: show what would change without writing")
    .option("--keep-locks", "keep the lock state at ~/.mic-lock (default: purge it)")
    .option("--force", "purge lock state even if an agent currently holds/awaits a lock")
    .action(uninstallAction);

  program
    .command("guard")
    .description("PreToolUse hook used by `setup`: blocks unwrapped shared-device commands")
    .action(guardAction);

  const config = program.command("config").description("Inspect and edit configuration");
  common(config.command("register <name>"))
    .description("Register a resource (mutex/semaphore/pool) with a fixed shape")
    .option("--kind <kind>", "mutex | semaphore | pool")
    .option("--capacity <n>", "slot count for a semaphore")
    .option("--device-ids <id...>", "device ids for a pool")
    .option("--ttl <sec>", "default lease seconds")
    .option("--heartbeat <sec>", "default heartbeat seconds")
    .option("--grace <sec>", "default grace seconds")
    .action(configRegisterAction);
  common(config.command("list")).description("List resources and defaults").action(configListAction);
  common(config.command("set-defaults"))
    .description("Set global default tunables (seconds)")
    .option("--ttl <sec>", "lease seconds")
    .option("--heartbeat <sec>", "heartbeat seconds")
    .option("--grace <sec>", "grace seconds")
    .action(configSetDefaultsAction);
  config.action(() => config.help());

  // Internal: concurrency stress worker used by the test suite.
  program
    .command("__hammer", { hidden: true })
    .option("--state-dir <path>")
    .requiredOption("--resource <name>")
    .requiredOption("--cs-dir <path>")
    .option("--iterations <n>")
    .option("--hold-ms <n>")
    .option("--capacity <n>")
    .option("--devices <id...>")
    .action(hammerAction);

  program.action(() => program.help());
  return program;
}

function isJsonMode(argv: string[]): boolean {
  return argv.includes("--json");
}

function handleError(err: unknown, argv: string[]): void {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode ?? ExitCode.USAGE;
    return;
  }
  if (err instanceof MicLockError) {
    if (isJsonMode(argv)) {
      emitJson({ ok: false, error: err.message, code: err.code, name: err.name });
    } else {
      errline(color.red(`✗ ${err.message}`));
    }
    process.exitCode = err.code;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isJsonMode(argv)) emitJson({ ok: false, error: message });
  else errline(color.red(`✗ ${message}`));
  process.exitCode = ExitCode.ERROR;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    handleError(err, argv);
  }
}
