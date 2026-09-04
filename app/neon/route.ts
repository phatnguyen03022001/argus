import { NextResponse } from "next/server";
import { refreshNeonProjectRequest } from "../../src/workspace-app";

function textField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const form = await request.formData();
  const destination = new URL("/", request.url);
  const result = await refreshNeonProjectRequest(textField(form.get("environmentProfileId")));
  if (!result.ok) destination.searchParams.set("error", result.error);
  return NextResponse.redirect(destination, 303);
}
