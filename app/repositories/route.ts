import { NextResponse } from "next/server";
import { refreshWorkspaceRepositoriesRequest } from "../../src/workspace-app";

function textField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const form = await request.formData();
  const workspaceId = textField(form.get("workspaceId")).trim();
  const result = workspaceId
    ? await refreshWorkspaceRepositoriesRequest(workspaceId)
    : { ok: false as const, error: "Workspace identity is required." };

  const destination = new URL("/", request.url);
  if (!result.ok) destination.searchParams.set("error", result.error);
  return NextResponse.redirect(destination, 303);
}
