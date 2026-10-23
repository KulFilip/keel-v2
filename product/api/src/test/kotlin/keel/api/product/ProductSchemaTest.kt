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
 * keel still starts (the history takes the new checksums), and any other history problem still stops it.
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
    fun `a failed migration in the history still stops keel`(@TempDir dir: Path) {
        val ds = sqlite(dir.resolve("keel.db"))
        ProductSchema(ds)
        sql(ds, "UPDATE product_schema_history SET success = 0 WHERE version = '4'")

        assertThatThrownBy { ProductSchema(ds) }.hasMessageContaining("failed")
    }
}
