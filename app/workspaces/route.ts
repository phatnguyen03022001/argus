import { NextResponse } from "next/server";
import { addWorkspaceRequest } from "../../src/workspace-app";

function textField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const form = await request.formData();
  const result = addWorkspaceRequest({
    label: textField(form.get("label")),
    root: textField(form.get("root")),
  });

  const destination = new URL("/", request.url);
  if (!result.ok) destination.searchParams.set("error", result.error);
  return NextResponse.redirect(destination, 303);
}
