package keel.api.plugins

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** Database addresses taken apart and built again: the fields the editor shows, never the password in them. */
class DbUrlsTest {
    @Test
    fun `reads PostgreSQL, MySQL, MariaDB and SQLite addresses into their fields`() {
        val pg = DbUrls.parse("postgres://app:s3cret@localhost:5432/scores")!! // keel:allow-secret
        assertThat(pg).isEqualTo(DbAddress("postgres", "localhost", 5432, "app", "s3cret", "scores"))
        assertThat(DbUrls.parse("postgresql://ro@db.internal/app")).isEqualTo(DbAddress("postgres", "db.internal", null, "ro", null, "app"))
        assertThat(DbUrls.parse("jdbc:postgresql://h:6543/d?user=a&password=q1w2e3&sslmode=require"))
            .isEqualTo(DbAddress("postgres", "h", 6543, "a", "q1w2e3", "d", params = "sslmode=require"))
        assertThat(DbUrls.parse("mysql://root:pw@127.0.0.1:10109/carrier_router")) // keel:allow-secret
            .isEqualTo(DbAddress("mysql", "127.0.0.1", 10109, "root", "pw", "carrier_router"))
        assertThat(DbUrls.parse("mariadb://u@maria:3307/")!!.driver).isEqualTo("mariadb")
        assertThat(DbUrls.parse("sqlite:data/app.db")).isEqualTo(DbAddress("sqlite", database = "data/app.db"))
        assertThat(DbUrls.parse("sqlite:///abs/app.db")).isEqualTo(DbAddress("sqlite", database = "/abs/app.db"))
        assertThat(DbUrls.parse("oracle://x@y/z")).isNull()
    }

    @Test
    fun `a password with any character survives the trip, and the address without it never holds it`() {
        val pw = "p@ss/w:rd?#%"
        val built = DbUrls.build(DbAddress("postgres", "h", 5432, "app", pw, "db"))
        assertThat(DbUrls.parse(built)!!.password).isEqualTo(pw)
        assertThat(DbUrls.withoutPassword(built)).isEqualTo("postgres://app@h:5432/db")
        assertThat(DbUrls.withPassword("postgres://app@h:5432/db", pw)).isEqualTo(built)
        assertThat(DbUrls.passwordOf("postgres://app:pa@ss@localhost/db")).isEqualTo("pa@ss") // keel:allow-secret
        // a secret in the query stays out of the address without the password, and comes back with it
        val tok = DbUrls.parse("postgres://h/db?token=abc123&sslmode=require")!!
        assertThat(DbUrls.build(tok, withPassword = false)).isEqualTo("postgres://h/db?sslmode=require")
        assertThat(DbUrls.build(tok)).contains("token=abc123")
    }

    @Test
    fun `sockets and IPv6 hosts`() {
        assertThat(DbUrls.build(DbAddress("postgres", username = "app", database = "db", socket = "/var/run/postgresql"), false))
            .isEqualTo("postgres://app@/db?host=%2Fvar%2Frun%2Fpostgresql")
        assertThat(DbUrls.parse("postgres://app@/db?host=%2Fvar%2Frun%2Fpostgresql")!!.socket).isEqualTo("/var/run/postgresql")
        assertThat(DbUrls.build(DbAddress("mysql", username = "root", database = "shop", socket = "/tmp/mysql.sock"), false))
            .isEqualTo("mysql://root@localhost/shop?unix_socket=%2Ftmp%2Fmysql.sock")
        assertThat(DbUrls.parse("postgres://u@[::1]:5433/d")).isEqualTo(DbAddress("postgres", "::1", 5433, "u", null, "d"))
        assertThat(DbUrls.build(DbAddress("postgres", "::1", 5433, "u", null, "d"))).isEqualTo("postgres://u@[::1]:5433/d")
    }

    @Test
    fun `an error text never carries the password`() {
        val url = "mysql://root:hunter22@db:3306/shop" // keel:allow-secret
        val text = "keel could not reach x: Access denied for root using password hunter22 at mysql://root:hunter22@db:3306/shop" // keel:allow-secret
        val clean = DatabaseService.scrub(text, url)!!
        assertThat(clean).doesNotContain("hunter22").contains("mysql://root:•••@db:3306/shop")
    }
}
