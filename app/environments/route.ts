import { NextResponse } from "next/server";
import {
  archiveEnvironmentProfileRequest,
  createEnvironmentProfileRequest,
} from "../../src/workspace-app";

function textField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function parseLines(value: string, kind: "setting" | "binding"): Array<{ key: string; value: string }> {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment ${kind} line.`);
    return { key: line.slice(0, separator), value: line.slice(separator + 1) };
  });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const intent = textField(form.get("intent"));
  const destination = new URL("/", request.url);

  if (intent === "archive") {
    const version = Number(textField(form.get("version")));
    const result = archiveEnvironmentProfileRequest(textField(form.get("id")), version);
    if (!result.ok) destination.searchParams.set("error", result.error);
    return NextResponse.redirect(destination, 303);
  }

  try {
    const settings = parseLines(textField(form.get("settings")), "setting")
      .map(({ key, value }) => ({ key, value }));
    const credentialBindings = parseLines(textField(form.get("credentialBindings")), "binding")
      .map(({ key, value }) => ({ key, credentialReferenceId: value }));
    const result = createEnvironmentProfileRequest({
      workspaceId: textField(form.get("workspaceId")),
      environmentName: textField(form.get("environmentName")),
      label: textField(form.get("label")),
      settings,
      credentialBindings,
    });
    if (!result.ok) destination.searchParams.set("error", result.error);
  } catch (error) {
    destination.searchParams.set("error", error instanceof Error ? error.message : "Environment profile input is invalid.");
  }
  return NextResponse.redirect(destination, 303);
}
