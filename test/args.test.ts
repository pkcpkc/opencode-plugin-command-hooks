import { describe, it, expect } from "vitest";
import { parseArguments, resolveCommandAndArgs } from "../src/utils/args.js";

describe("Utility: parseArguments", () => {
  it("should split normal arguments", () => {
    expect(parseArguments("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("should respect double quotes", () => {
    expect(parseArguments('foo "bar baz"')).toEqual(["foo", "bar baz"]);
  });

  it("should respect single quotes", () => {
    expect(parseArguments("foo 'bar baz'")).toEqual(["foo", "bar baz"]);
  });

  it("should handle escaped quotes", () => {
    expect(parseArguments('foo \\"bar')).toEqual(["foo", '"bar']);
  });

  it("should handle empty arguments in quotes", () => {
    expect(parseArguments('foo "" bar')).toEqual(["foo", "", "bar"]);
  });

  it("should handle multiple spaces", () => {
    expect(parseArguments("foo   bar")).toEqual(["foo", "bar"]);
  });

  it("should handle trailing escape character gracefully", () => {
    expect(parseArguments("foo \\")).toEqual(["foo"]);
  });

  it("should handle empty input gracefully", () => {
    expect(parseArguments("")).toEqual([]);
  });

  it("should handle quotes containing escaped quotes", () => {
    expect(parseArguments('foo "bar \\"baz\\""')).toEqual(["foo", 'bar "baz"']);
  });
});

describe("Utility: resolveCommandAndArgs", () => {
  it("should map positional placeholders", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd $2 $1", "foo bar");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: "bar foo"
    });
  });

  it("should substitute $args with full string", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd $args", "foo bar");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: "foo bar"
    });
  });

  it("should substitute alternative full args placeholders ($* and $@)", () => {
    const resolvedStar = resolveCommandAndArgs("/pre-cmd $*", "foo bar");
    expect(resolvedStar).toEqual({
      command: "/pre-cmd",
      arguments: "foo bar"
    });

    const resolvedAt = resolveCommandAndArgs("/pre-cmd $@", "foo bar");
    expect(resolvedAt).toEqual({
      command: "/pre-cmd",
      arguments: "foo bar"
    });
  });

  it("should quote substituted arguments containing spaces", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd $2", "foo \"bar baz\"");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: "\"bar baz\""
    });
  });

  it("should return empty arguments if none specified", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd", "foo bar");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: ""
    });
  });

  it("should resolve missing positional placeholders to empty string", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd $9", "foo bar");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: ""
    });
  });

  it("should resolve duplicate positional placeholders correctly", () => {
    const resolved = resolveCommandAndArgs("/pre-cmd $1 $1 $2", "foo bar");
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: "foo foo bar"
    });
  });

  it("should handle empty preCmd string gracefully", () => {
    const resolved = resolveCommandAndArgs("", "foo bar");
    expect(resolved).toEqual({
      command: "",
      arguments: ""
    });
  });

  it("should handle complex nested substitutions and escape quotes in auto-quotes", () => {
    const resolved = resolveCommandAndArgs('/pre-cmd $1 $2', 'foo "bar baz"');
    expect(resolved).toEqual({
      command: "/pre-cmd",
      arguments: "foo \"bar baz\""
    });
  });
});
