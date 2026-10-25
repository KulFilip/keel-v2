package keel.api.product

import keel.product.ProductSchema
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.sqlite.SQLiteDataSource
import java.nio.file.Path

/**
 * 0.18.47 changed only comments in P3 and P4, so a keel Product database from before has other checksums for them:
 * keel still starts (the history takes the new checksums), also when a new migration waits to run (0.18.46 straight to
 * 0.18.54), and any other history problem on an applied migration still stops it.
 */
class ProductSchemaTest {
    private fun sqlite(file: Path) = SQLiteDataSource().apply { url = "jdbc:sqlite:$file" }

    private fun sql(ds: SQLiteDataSource, q: String) = ds.connection.use { it.createStatement().executeUpdate(q) }

    private fun checksum(ds: SQLiteDataSource, version: String): Int = ds.connection.use { c ->
        c.createStatement().executeQuery("SELECT checksum FROM product_schema_history WHERE version = '$version'").use { it.next(); it.getInt(1) }
    }

    @Test
    fun `a database whose P3 and P4 ran with the old comments starts and takes the new checksums`(@TempDir dir: Path) {
        val ds = sqlite(dir.resolve("keel.db"))
        ProductSchema(ds)
        val now3 = checksum(ds, "3")
        val now4 = checksum(ds, "4")
        sql(ds, "UPDATE product_schema_history SET checksum = checksum + 1 WHERE version IN ('3', '4')")

        ProductSchema(ds)

        assertThat(checksum(ds, "3")).isEqualTo(now3)
        assertThat(checksum(ds, "4")).isEqualTo(now4)
    }

    @Test
    fun `an upgrade with old P3 and P4 checksums and a new pending migration repairs and migrates`(@TempDir dir: Path) {
        val ds = sqlite(dir.resolve("keel.db"))
        ProductSchema(ds)
        val now3 = checksum(ds, "3")
        // as 0.18.46 left it: P3 and P4 with the old checksums, and P7 not run yet
        sql(ds, "UPDATE product_schema_history SET checksum = checksum + 1 WHERE version IN ('3', '4')")
        sql(ds, "DELETE FROM product_schema_history WHERE version = '7'")
        sql(ds, "DROP TABLE product_initiative_tickets")

        ProductSchema(ds)

        assertThat(checksum(ds, "3")).isEqualTo(now3)
        assertThat(ds.connection.use { c ->
            c.createStatement().executeQuery("SELECT COUNT(*) FROM product_schema_history WHERE version = '7' AND success = 1")
                .use { it.next(); it.getInt(1) }
        }).isEqualTo(1)
        sql(ds, "INSERT INTO product_initiative_tickets(initiative_id, key, added_at) VALUES ('i1', 'K-1', 'now')")
    }

    @Test
    fun `a failed migration in the history still stops keel`(@TempDir dir: Path) {
        val ds = sqlite(dir.resolve("keel.db"))
        ProductSchema(ds)
        sql(ds, "UPDATE product_schema_history SET success = 0 WHERE version = '4'")

        assertThatThrownBy { ProductSchema(ds) }.hasMessageContaining("failed")
    }
}
