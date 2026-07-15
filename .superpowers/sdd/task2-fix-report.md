# Schema Guard Task 2 Fix Report

## RED

先加入 digest 格式与截断证据的回归测试并运行：

```text
node --test skills/schema-guard/tests/*.test.mjs
```

结果：31 passed, 3 failed。失败正是新增测试预期：任意文本 digest 未被拒绝；`provenance.truncated: true` 和顶层 `truncated: true` 未触发非零退出。

## GREEN

实现 `sha256:<64 lowercase hex>` 校验，并在解析 extracted 之前同时拒绝 `fetch_result.provenance.truncated === true` 与顶层 `fetch_result.truncated === true`。

运行：

```text
node --test skills/schema-guard/tests/*.test.mjs
```

结果：34 passed, 0 failed。

## SHA

提交 SHA 见最终交付状态。
