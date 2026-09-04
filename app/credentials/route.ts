import { NextResponse } from "next/server";
import {
  archiveCredentialReferenceRequest,
  createCredentialReferenceRequest,
} from "../../src/workspace-app";

function textField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const form = await request.formData();
  const intent = textField(form.get("intent"));
  const destination = new URL("/", request.url);

  if (intent === "archive") {
    const version = Number(textField(form.get("version")));
    const result = archiveCredentialReferenceRequest(textField(form.get("id")), version);
    if (!result.ok) destination.searchParams.set("error", result.error);
    return NextResponse.redirect(destination, 303);
  }

  const result = createCredentialReferenceRequest({
    externalSystem: textField(form.get("externalSystem")),
    keychainService: textField(form.get("keychainService")),
    keychainAccount: textField(form.get("keychainAccount")),
    label: textField(form.get("label")),
  });
  if (!result.ok) destination.searchParams.set("error", result.error);
  return NextResponse.redirect(destination, 303);
}
