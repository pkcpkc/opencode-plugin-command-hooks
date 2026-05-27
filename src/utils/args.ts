export function parseArguments(argsStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let escaped = false;
  let seenCharInToken = false;

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      seenCharInToken = true;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      seenCharInToken = true;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      seenCharInToken = true;
      continue;
    }

    if (char === ' ' && !inDoubleQuotes && !inSingleQuotes) {
      if (seenCharInToken || current.length > 0) {
        result.push(current);
        current = "";
        seenCharInToken = false;
      }
    } else {
      current += char;
      seenCharInToken = true;
    }
  }

  if (seenCharInToken || current.length > 0) {
    result.push(current);
  }

  return result;
}

export function resolveCommandAndArgs(preCmd: string, parentArgsStr: string): { command: string, arguments: string } {
  const parsedPreCmd = parseArguments(preCmd);
  if (parsedPreCmd.length === 0) {
    return { command: "", arguments: "" };
  }

  const childCmdName = parsedPreCmd[0];
  const childCmdArgTemplates = parsedPreCmd.slice(1);
  const parsedParentArgs = parseArguments(parentArgsStr);

  const substitutedArgs = childCmdArgTemplates.map(argTemplate => {
    let resolved = argTemplate.replace(/\$(\d+)/g, (_, num) => {
      const idx = parseInt(num, 10) - 1;
      return parsedParentArgs[idx] !== undefined ? parsedParentArgs[idx] : "";
    });

    const isFullArgsPlaceholder = /\$(args|@|\*)/.test(resolved);
    resolved = resolved.replace(/\$(args|@|\*)/g, () => {
      return parentArgsStr;
    });
    
    // If the resolved argument contains spaces and is not already quoted, we quote it
    // But we bypass this if the placeholder represented the entire arguments string ($args, etc.)
    if (!isFullArgsPlaceholder && resolved.includes(" ") && !resolved.startsWith('"') && !resolved.startsWith("'")) {
      return `"${resolved.replace(/"/g, '\\"')}"`;
    }
    return resolved;
  });

  return {
    command: childCmdName,
    arguments: substitutedArgs.join(" ")
  };
}
