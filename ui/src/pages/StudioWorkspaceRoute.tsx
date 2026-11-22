import { useParams } from "@/lib/router";
import { StudioWorkspace } from "./StudioWorkspace";

/**
 * One App Studio project per page instance. The workspace page keeps the open
 * file, the editor text, unsaved drafts and the AI's turns in its own state,
 * so when the address moves from one project to another without a reload (a
 * tapped notification does this) the new project must start from nothing.
 * The key makes React throw the first instance away and mount a new one.
 */
export function StudioWorkspaceRoute() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <StudioWorkspace key={workspaceId} />;
}
