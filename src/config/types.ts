export interface WorkspacePolicy {
  allow_current_working_tree: boolean;
}

export interface WorkspaceRecord {
  workspace_id: string;
  workspace_name: string;
  machine: string;
  root: string;
  git_root: string;
  git_remote: string | null;
  created_at: string;
  policy: WorkspacePolicy;
}

export interface WorkspaceRegistryIndex {
  roots: Record<string, string>;
}
