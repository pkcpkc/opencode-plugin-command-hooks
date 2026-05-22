# opencode-plugin-command-hooks

A generic, highly flexible plugin for **OpenCode** that adds powerful hooks and dependency chains to any command execution. It enables you to orchestrate workflows with both **JSON command chains** and **shell scripts** (`.pre.sh` and `.post.sh`) executed recursively with felsenfest execution order and error safety.

---

## Features

- 🛠️ **Command Chains**: Define pre and post command sequences in standard `<command-name>.commands.json` files.
- 🐚 **Shell Scripts**: Automatically run shell scripts (`<command-name>.pre.sh` and `<command-name>.post.sh`) before and after command executions.
- 🎯 **Strict Execution Order**: Guarantees a robust, predictable pipeline sequence.
- 🛑 **Failure Propagation & Safe Abort**: If a pre-command or pre-script fails (non-zero exit code or error), the pipeline aborts immediately, stopping the main command.
- 🔄 **Recursive Support**: Fully supports nested/recursive command invocations natively using OpenCode's command system.
- 📝 **Detailed Logging & Session Output**: Output from pre/post shell scripts is logged to a local file, reported to OpenCode's logs, and printed back directly to the active session when a failure occurs.

---

## Execution Pipeline Order

When a command (e.g. `wiki-sync`) is invoked, the plugin executes hooks in this felsenfest sequence:

```mermaid
graph TD
    A[Start: Command Execute] --> B["1. JSON Pre-commands (.commands.json)"]
    B --> C["2. Shell Pre-script (.pre.sh)"]
    C --> D[3. Main Command]
    D --> E["4. Shell Post-script (.post.sh)"]
    E --> F["5. JSON Post-commands (.commands.json)"]
    F --> G[Finish: Command Executed]
```

### Flow Details
1. **JSON Pre-commands**: Defined in `.opencode/commands/<command>.commands.json`. Executed sequentially. *Any failure aborts the pipeline.*
2. **Shell Pre-script**: Located at `.opencode/commands/<command>.pre.sh`. *Non-zero exit codes abort the pipeline.*
3. **Main Command**: Your command executes.
4. **Shell Post-script**: Located at `.opencode/commands/<command>.post.sh`. Executed for cleanup/logs. *Failure is logged but doesn't abort (main command already ran).*
5. **JSON Post-commands**: Defined in `.opencode/commands/<command>.commands.json`. Executed sequentially. *Failure is logged but doesn't abort.*

---

## Installation

Add the package to your OpenCode project:

```bash
npm install opencode-plugin-command-hooks
```

Or copy the folder directly to your local plugins directory.

---

## Setup & Configuration

### Option 1: Natively Registered Plugin

Create an `opencode.json` configuration file in your project root containing:

```json
{
  "plugin": [
    "@pkcpkc/opencode-plugin-command-hooks"
  ]
}
```

### Option 2: Programmatic Registration

Import and register the plugin in your `.opencode` plugins registration file:

```typescript
import { CommandHooksPlugin } from "opencode-plugin-command-hooks";

export default [
  // Register the plugin with custom options
  CommandHooksPlugin({
    commandsDirectory: ".opencode/commands",
    logLevel: "error", // "debug" | "info" | "warn" | "error"
    logFilePath: ".opencode/plugins/commandHooks.log"
  })
];
```

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `commandsDirectory` | `string` | `".opencode/commands"` | Directory where your scripts and command JSON chains reside. |
| `logLevel` | `string` | `"error"` | Log verbosity level for local files and toast messages. |
| `logFilePath` | `string` | `".opencode/plugins/commandHooks.log"` | Absolute or relative path to save execution logs. |

---

## Examples

### 1. Defining a Command Chain (`.commands.json`)

To run multiple dependent commands before and after executing `/wiki-sync`, create a `.opencode/commands/wiki-sync.commands.json` file:

```json
{
  "pre": [
    "/wiki-lint",
    "/wiki-report"
  ],
  "post": [
    "/wiki-clean"
  ]
}
```

*When `/wiki-sync` is executed, the plugin will first call `/wiki-lint` and `/wiki-report` using `client.session.command`, and call `/wiki-clean` after it finishes.*

### 2. Pre-execution Shell Script (`.pre.sh`)

To run custom checks (like verifying network connection or repository state) before executing a command, create a `.opencode/commands/wiki-sync.pre.sh` file:

```bash
#!/bin/bash
echo "Verifying local Obsidian vaults..."
# Exit with non-zero code to block the main command execution
if [ ! -d "./Vaults" ]; then
  echo "Error: Vaults directory does not exist!" >&2
  exit 1
fi
echo "Vaults directory verified successfully."
exit 0
```

### 3. Post-execution Shell Script (`.post.sh`)

To perform post-execution notifications or cleanups, create `.opencode/commands/wiki-sync.post.sh`:

```bash
#!/bin/bash
echo "Wiki sync completed at $(date)"
# Perfect for running notifications, webhooks, or generating reports
```

---

## Error Handling Matrix

| Phase | Action on Error / Non-zero Exit | Toast Notification | Session Log output |
|---|---|---|---|
| **JSON Pre-commands** | **Aborts execution immediately**. Subsequent hooks and main command do **not** run. | 🔴 Error toast shown | Yes |
| **Shell Pre-script** | **Aborts execution immediately**. Main command does **not** run. | 🔴 Error toast shown | Yes, including stdout & stderr |
| **Shell Post-script** | Logs error. Execution finishes normally. | 🟡 Warning toast shown | Yes (if log level allows) |
| **JSON Post-commands**| Logs error. Execution finishes normally. | 🔴 Error toast shown | Yes |

---

## Development & Build

If you are modifying this plugin:

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Run Tests**:
   ```bash
   npm test
   ```
   *This executes the comprehensive unit/integration test suite via Vitest.*
3. **Build**:
   ```bash
   npm run build
   ```

This generates the bundled output inside `dist/`.
