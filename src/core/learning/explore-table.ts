// 两种探索技能（explore-phrase / explore-vocabulary）共享的会话表格单元格
// 转义：单元格按纯文本处理，先转义反斜杠与 Markdown 标记（管道符、反引号、
// 强调、链接/图片方括号、删除线），再转义 HTML 字符，防止内容拆列、插入
// 链接、图片或 HTML。句点、冒号与 @ 也一并转义：渲染结果不变，但破坏 GFM
// 对裸 URL、www 前缀与邮箱的自动链接匹配。条目已由 schema 限定单行，不
// 通过换行破坏表格。
export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/([\\|`*_[\]~.:@])/gu, '\\$1')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}
