mod env;
mod receipts;
#[cfg(any(feature = "cli-tool", feature = "mcp"))]
mod sandbox;
mod tool_roots;

#[cfg(any(feature = "mcp", feature = "agent"))]
pub(crate) use env::process_env_snapshot;
pub(crate) use env::{WorkspaceEnv, process_env_value};
pub(crate) use receipts::ReceiptServices;
#[cfg(any(feature = "cli-tool", feature = "mcp"))]
pub(crate) use sandbox::SandboxServices;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use crate::receipts::RuntimeReceiptSignatureConfig;
    use crate::receipts::paths::{RUNX_CWD_ENV, RUNX_PROJECT_DIR_ENV};
    use crate::services::{ReceiptServices, WorkspaceEnv};

    #[test]
    fn graph_env_injects_workspace_and_project_paths() {
        let workspace = WorkspaceEnv::new(BTreeMap::new(), PathBuf::from("/tmp/runx-work"));

        let env = workspace.graph_env_for_skill(Path::new("/tmp/runx-work/skills/demo"));

        assert_eq!(env.get(RUNX_CWD_ENV), Some(&"/tmp/runx-work".to_owned()));
        assert_eq!(
            env.get(RUNX_PROJECT_DIR_ENV),
            Some(&"/tmp/runx-work".to_owned())
        );
    }

    #[test]
    fn receipt_services_resolve_paths_from_workspace_env() {
        let env = BTreeMap::from([(RUNX_PROJECT_DIR_ENV.to_owned(), ".runx-custom".to_owned())]);
        let workspace = WorkspaceEnv::new(env, PathBuf::from("/tmp/runx-work"));
        let receipts = ReceiptServices::from_signature_config(
            RuntimeReceiptSignatureConfig::local_development(),
        );

        let resolved = receipts.resolve_path(&workspace, None, None);

        assert_eq!(
            resolved.path,
            PathBuf::from("/tmp/runx-work/.runx-custom/receipts")
        );
    }
}
