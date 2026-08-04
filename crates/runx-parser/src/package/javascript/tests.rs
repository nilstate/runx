use super::{module_imports, process_module_imports};

#[test]
fn finds_static_and_literal_dynamic_imports_without_reading_comments_or_strings() {
    let source = r#"
        // import "./ignored.mjs";
        const prose = "import './also-ignored.mjs'";
        import { one } from "./one.mjs";
        export { two } from './two.js';
    "#;
    assert_eq!(
        module_imports("domain/main.mjs", source),
        Ok(vec!["./one.mjs".to_owned(), "./two.js".to_owned(),])
    );
}

#[test]
fn rejects_dynamic_import_even_with_a_literal_specifier() {
    let error = module_imports("domain/main.mjs", "import('./other.mjs')")
        .err()
        .map(|error| error.to_string());
    assert!(error.is_some_and(|message| message.contains("dynamic import()")));
}

#[test]
fn process_import_scan_does_not_treat_exported_function_bodies_as_re_exports() {
    let source = r#"
        import fs from "node:fs";
        export function createStore(from) {
            return from ?? fs;
        }
    "#;

    assert_eq!(
        process_module_imports("tools/data/store/run.mjs", source),
        Ok(vec!["node:fs".to_owned()])
    );
}

#[test]
fn process_import_scan_accepts_node_shebangs() {
    assert_eq!(
        process_module_imports(
            "tools/provider/action/run.mjs",
            "#!/usr/bin/env node\nimport fs from 'node:fs';\n",
        ),
        Ok(vec!["node:fs".to_owned()])
    );
}

#[test]
fn process_import_scan_collects_static_commonjs_dependencies() {
    assert_eq!(
        process_module_imports(
            "tools/provider/action/run.cjs",
            "const helper = require('./helper.cjs');\n",
        ),
        Ok(vec!["./helper.cjs".to_owned()])
    );
}

#[test]
fn process_import_scan_rejects_dynamic_commonjs_dependencies() {
    let error = process_module_imports(
        "tools/provider/action/run.cjs",
        "const helper = require(process.env.HELPER);\n",
    )
    .err()
    .map(|error| error.to_string());

    assert!(error.is_some_and(|message| message.contains("only static require")));
}

#[test]
fn ignores_quotes_and_import_words_inside_regular_expressions() {
    let source = r#"
        const segment = value.split(/\s+/)[0]?.replace(/[^a-zA-Z'-]/g, "");
        const field = value.replace(/^['"]|['"]$/gu, "");
        const marker = /import\(['"]ignored['"]\)/u;
        import actual from "./actual.mjs";
    "#;

    assert_eq!(
        module_imports("domain/main.mjs", source),
        Ok(vec!["./actual.mjs".to_owned()])
    );
}

#[test]
fn rejects_effect_and_process_plumbing_outside_literals() {
    for (source, boundary) in [
        ("export default () => fetch('/data');", "fetch"),
        ("export default () => require('node:fs');", "require"),
        (
            "export default () => process.env.TOKEN;",
            "process runtime plumbing",
        ),
        ("export default () => RUNX_INPUTS_JSON;", "RUNX_INPUTS_JSON"),
    ] {
        let error = module_imports("domain/main.mjs", source)
            .err()
            .map(|error| error.to_string());
        assert!(
            error
                .as_deref()
                .is_some_and(|message| message.contains(boundary)),
            "unexpected result: {error:?}"
        );
    }
    assert!(
        module_imports(
            "domain/main.mjs",
            "export default () => 'fetch() process.env RUNX_INPUTS_JSON';",
        )
        .is_ok(),
        "effect-like text inside a string is data, not executable plumbing"
    );
}
