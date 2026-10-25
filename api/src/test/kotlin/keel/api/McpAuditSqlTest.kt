package keel.api

import keel.api.mcp.McpAudit
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** keel 0.18.55: the SQL an MCP call sends is in its audit event, without the secrets in its literals, at most ~2000 chars. */
class McpAuditSqlTest {
    @Test
    fun `secrets in literals are masked and the rest stays`() {
        assertThat(McpAudit.auditSql("UPDATE users SET password_hash = 'abc', name = 'Ada' WHERE api_key <> 'k-123'"))
            .isEqualTo("UPDATE users SET password_hash = '•••', name = 'Ada' WHERE api_key <> '•••'")
        assertThat(McpAudit.auditSql("insert into users (name, password) values ('Ada', 's3cret'), ('Bo', 'x')"))
            .isEqualTo("insert into users (name, password) values ('•••', '•••'), ('•••', '•••')")
        assertThat(McpAudit.auditSql("SELECT * FROM t WHERE token IN ('a', 'b') AND secret LIKE 'x%'"))
            .isEqualTo("SELECT * FROM t WHERE token IN ('•••', '•••') AND secret LIKE '•••'")
        assertThat(McpAudit.auditSql("SELECT 'postgres://app:pw1@h/db' AS u")).isEqualTo("SELECT 'postgres://app:•••@h/db' AS u") // keel:allow-secret
        assertThat(McpAudit.auditSql("CREATE USER x IDENTIFIED BY 'pw'")).isEqualTo("CREATE USER x IDENTIFIED BY '•••'")
        assertThat(McpAudit.auditSql("select name from players where name = 'it''s'")).isEqualTo("select name from players where name = 'it''s'")
    }

    @Test
    fun `a long statement is cut`() {
        val out = McpAudit.auditSql("select '" + "x".repeat(5000) + "'")
        assertThat(out.length).isEqualTo(2001)
        assertThat(out).endsWith("…")
    }
}
