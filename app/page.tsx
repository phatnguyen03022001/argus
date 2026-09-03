import { loadWorkspaceHome } from "../src/workspace-app";
import { WorkspaceHome } from "../src/workspace-home";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const { workspaces } = loadWorkspaceHome();
  return <WorkspaceHome workspaces={workspaces} error={error} />;
}
