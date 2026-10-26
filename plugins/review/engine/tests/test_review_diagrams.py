"""The overview's diagrams (Database and System tabs): the migration readers (Flyway SQL, Doctrine, Laravel, Alembic and
the others), the before -> after diff and its risks, the system graph from paths and config, the Mermaid and ASCII text,
and the engine route on a demo repository ("shop": orders, order_items, refunds, shipments; a message consumer; a cron
publisher). No model: everything here is read from git."""

import subprocess
from pathlib import Path

import pytest

from keel_plugin_review import diagrams
from keel_plugin_review.diagrams import detect, othermig, php, pymig, render, sql, system
from keel_plugin_review.diagrams.schema import Schema, describe, diff, risks


def _apply(ops, path="m.sql", into=None):
    s = into or Schema()
    for o in ops:
        s.apply(o, path)
    return s


def _kinds(ops):
    return [(o.kind, o.table) for o in ops]


BASE_SQL = """CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  total NUMERIC(10,2) NOT NULL
);
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  sku VARCHAR(40) NOT NULL
);
CREATE INDEX ix_order_items_order ON order_items (order_id);
CREATE TABLE shipments (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  legacy_code VARCHAR(10)
);
"""

CHANGE_SQL = """-- refunds for orders
CREATE TABLE refunds (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  reason VARCHAR(200)
);
ALTER TABLE orders ADD COLUMN refund_total NUMERIC(10,2) NOT NULL;
ALTER TABLE shipments ADD CONSTRAINT fk_shipments_order FOREIGN KEY (order_id) REFERENCES orders (id);
ALTER TABLE shipments DROP COLUMN legacy_code;
"""


# ------------------------------------------------------------------ the readers

def test_flyway_sql_reads_tables_columns_keys_and_lines():
    ops = sql.parse(CHANGE_SQL)
    assert _kinds(ops) == [("create_table", "refunds"), ("add_column", "orders"), ("add_fk", "shipments"), ("drop_column", "shipments")]
    create = ops[0]
    cols = {c["name"]: c for c in create.table_def["columns"]}
    assert create.line == 2 and cols["order_id"]["line"] == 4
    assert cols["id"]["pk"] and cols["id"]["auto"] and cols["amount"]["type"] == "NUMERIC(10,2)"
    assert cols["order_id"]["fk"]["ref_table"] == "orders" and cols["order_id"]["fk"]["on_delete"] == "CASCADE"
    assert cols["reason"]["nullable"] is None and cols["amount"]["nullable"] is False
    assert ops[1].line == 8 and ops[1].column == {**ops[1].column, "name": "refund_total", "nullable": False, "default": None}
    assert describe(ops[1]) == "adds column orders.refund_total (NUMERIC(10,2), not null)"
    assert describe(ops[3]) == "drops column shipments.legacy_code: its data is deleted"


def test_sql_reads_the_other_spellings_and_never_skips_silently():
    ops = sql.parse("""
ALTER TABLE `orders` MODIFY `status` VARCHAR(32) NOT NULL, ADD INDEX ix_status (status);
ALTER TABLE public.orders ALTER COLUMN total SET DATA TYPE numeric(12,2), ALTER COLUMN status DROP DEFAULT;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_sku ON order_items USING btree (sku);
RENAME TABLE shipments TO deliveries;
ALTER TABLE deliveries RENAME COLUMN order_id TO order_ref;
UPDATE orders SET status = 'new' WHERE status IS NULL;
CREATE OR REPLACE VIEW open_orders AS SELECT * FROM orders;
GRANT SELECT ON orders TO reporting;
MERGE SOME NONSENSE;
-- +goose Down
DROP TABLE orders;
""")
    assert _kinds(ops) == [("alter_column", "orders"), ("add_index", "orders"), ("alter_column", "orders"), ("alter_column", "orders"),
                           ("add_index", "order_items"), ("rename_table", "shipments"), ("rename_column", "deliveries"),
                           ("data", "orders"), ("data", "SOME")]
    assert ops[0].column["type"] == "VARCHAR(32)" and ops[0].column["nullable"] is False
    assert ops[4].unique and ops[4].columns == ["sku"]
    assert ops[5].to == "deliveries" and ops[6].to == "order_ref"
    bad = sql.parse("CREATE TABLE;\nFROBNICATE orders;")
    assert [o.kind for o in bad] == ["unknown", "unknown"] and bad[1].line == 2


def test_doctrine_reads_addsql_in_up_only_with_the_php_lines():
    text = """<?php
declare(strict_types=1);
namespace DoctrineMigrations;
final class Version20261020101500 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE refunds (id INT AUTO_INCREMENT NOT NULL, order_id INT NOT NULL, '
            . 'amount NUMERIC(10, 2) NOT NULL, PRIMARY KEY(id))');
        $this->addSql('ALTER TABLE refunds ADD CONSTRAINT FK_REFUND_ORDER FOREIGN KEY (order_id) REFERENCES orders (id)');
        $this->addSql("ALTER TABLE orders ADD refunded_at DATETIME DEFAULT NULL");
        $this->addSql(<<<'SQL'
            ALTER TABLE order_items
                ADD refund_id INT NOT NULL
            SQL);
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE refunds');
    }
}
"""
    ops = php.doctrine(text)
    assert _kinds(ops) == [("create_table", "refunds"), ("add_fk", "refunds"), ("add_column", "orders"), ("add_column", "order_items")]
    assert [o.line for o in ops] == [8, 10, 11, 14]          # an ALTER points at its ADD line
    assert ops[0].table_def["pk"] == ["id"] and [c["name"] for c in ops[0].table_def["columns"]] == ["id", "order_id", "amount"]
    assert ops[2].column["nullable"] is True and ops[2].column["default"] is None
    assert ops[3].column["nullable"] is False
    assert detect.kind_of("migrations/Version20261020101500.php", text) == ("doctrine", "migration")
    schema_api = "<?php class Version1 extends AbstractMigration { public function up(Schema $schema): void {\n$t = $schema->createTable('x'); } }"
    assert [o.kind for o in php.doctrine(schema_api)] == ["unknown"]


def test_laravel_reads_the_schema_builder():
    text = """<?php
use Illuminate\\Database\\Migrations\\Migration;
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('refunds', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->constrained()->cascadeOnDelete();
            $table->decimal('amount', 10, 2);
            $table->string('reason', 200)->nullable();
            $table->timestamps();
        });
        Schema::table('orders', function (Blueprint $table) {
            $table->string('refund_status', 20);
            $table->integer('refund_count')->default(0);
            $table->unique('external_ref');
            $table->string('status', 32)->change();
            $table->dropColumn(['legacy_code', 'old_flag']);
        });
        DB::table('orders')->update(['refund_count' => 0]);
    }

    public function down(): void
    {
        Schema::dropIfExists('refunds');
    }
};
"""
    ops = php.laravel(text)
    assert _kinds(ops) == [("create_table", "refunds"), ("add_column", "orders"), ("add_column", "orders"), ("add_unique", "orders"),
                           ("alter_column", "orders"), ("drop_column", "orders"), ("drop_column", "orders"), ("data", "orders")]
    cols = {c["name"]: c for c in ops[0].table_def["columns"]}
    assert list(cols) == ["id", "order_id", "amount", "reason", "created_at", "updated_at"]
    assert cols["id"]["pk"] and cols["order_id"]["fk"] == {"name": None, "columns": ["order_id"], "ref_table": "orders",
                                                           "ref_columns": ["id"], "on_delete": "CASCADE"}
    assert cols["amount"]["type"] == "decimal(10,2)" and cols["amount"]["nullable"] is False
    assert cols["reason"]["nullable"] is True and cols["order_id"]["line"] == 9
    assert ops[1].line == 15 and ops[1].column["nullable"] is False and ops[1].column["default"] is None
    assert ops[2].column["default"] == "0"
    assert ops[4].name == "status" and ops[4].column["type"] == "varchar(32)"
    assert detect.kind_of("database/migrations/2026_10_20_000000_create_refunds_table.php", text) == ("laravel", "migration")


def test_alembic_reads_op_calls_in_upgrade_with_batch_and_execute():
    text = '''"""refunds"""
from alembic import op
import sqlalchemy as sa

revision = "b2c3"
down_revision = "a1b2"


def upgrade():
    op.create_table(
        "refunds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
    )
    op.add_column("orders", sa.Column("refund_total", sa.Numeric(10, 2), nullable=False))
    op.add_column("orders", sa.Column("refund_note", sa.Text()))
    op.create_index(op.f("ix_refunds_order_id"), "refunds", ["order_id"], unique=False)
    op.create_unique_constraint("uq_shipments_order", "shipments", ["order_id"])
    with op.batch_alter_table("shipments") as batch_op:
        batch_op.drop_column("legacy_code")
        batch_op.alter_column("carrier", nullable=False, existing_type=sa.String(20))
    op.execute("UPDATE orders SET refund_total = 0")


def downgrade():
    op.drop_table("refunds")
'''
    ops = pymig.alembic(text)
    assert _kinds(ops) == [("create_table", "refunds"), ("add_column", "orders"), ("add_column", "orders"), ("add_index", "refunds"),
                           ("add_unique", "shipments"), ("drop_column", "shipments"), ("alter_column", "shipments"), ("data", "orders")]
    cols = {c["name"]: c for c in ops[0].table_def["columns"]}
    assert cols["order_id"]["fk"]["ref_table"] == "orders" and cols["order_id"]["fk"]["on_delete"] == "CASCADE"
    assert cols["amount"]["type"] == "numeric(10,2)" and ops[0].table_def["pk"] == ["id"]
    assert ops[1].line == 16 and ops[1].column["nullable"] is False and ops[2].column["nullable"] is True
    assert ops[3].name == "ix_refunds_order_id" and ops[6].column == {"nullable": False}
    assert detect.kind_of("alembic/versions/b2c3_refunds.py", text) == ("alembic", "migration")
    first = '''revision = "a1b2"\ndown_revision = None\ndef upgrade():\n    pass\n'''
    assert [p for p, _ in detect.alembic_order([("versions/z.py", text), ("versions/a.py", first)])] == ["versions/a.py", "versions/z.py"]


def test_rails_django_liquibase_prisma_and_typeorm_are_read_too():
    rails = """class CreateRefunds < ActiveRecord::Migration[7.1]
  def change
    create_table :refunds do |t|
      t.references :order, null: false, foreign_key: true
      t.decimal :amount, precision: 10, scale: 2, null: false
      t.timestamps
    end
    add_column :orders, :refund_total, :decimal, null: false
    remove_column :shipments, :legacy_code
  end
end
"""
    assert _kinds(othermig.rails(rails)) == [("create_table", "refunds"), ("add_column", "orders"), ("drop_column", "shipments")]
    refunds = othermig.rails(rails)[0].table_def
    assert [c["name"] for c in refunds["columns"]] == ["id", "order_id", "amount", "created_at", "updated_at"]
    assert refunds["fks"][0]["ref_table"] == "orders" and refunds["indexes"][0]["columns"] == ["order_id"]
    django = """from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):
    operations = [
        migrations.CreateModel(
            name='Refund',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('amount', models.DecimalField(max_digits=10, decimal_places=2)),
                ('order', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='shop.order')),
            ],
        ),
        migrations.AddField(model_name='order', name='refund_total', field=models.DecimalField(max_digits=10, decimal_places=2)),
    ]
"""
    dj = pymig.django(django, "shop")
    assert _kinds(dj) == [("create_table", "shop_refund"), ("add_column", "shop_order"), ("add_index", "shop_refund")] or \
        _kinds(dj)[:2] == [("create_table", "shop_refund"), ("add_column", "shop_order")]
    assert {c["name"] for c in dj[0].table_def["columns"]} == {"id", "amount", "order_id"}
    xml = """<?xml version="1.0"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="shop">
    <createTable tableName="refunds">
      <column name="id" type="BIGINT" autoIncrement="true"><constraints primaryKey="true"/></column>
      <column name="order_id" type="BIGINT"><constraints nullable="false" foreignKeyName="fk_ref" references="orders(id)"/></column>
    </createTable>
    <addColumn tableName="orders"><column name="refund_total" type="DECIMAL(10,2)"><constraints nullable="false"/></column></addColumn>
  </changeSet>
</databaseChangeLog>
"""
    lb = othermig.liquibase_xml(xml)
    assert _kinds(lb) == [("create_table", "refunds"), ("add_column", "orders")] and lb[1].line == 8
    prisma = """model Order {\n  id Int @id @default(autoincrement())\n  refunds Refund[]\n  @@map("orders")\n}\n
model Refund {\n  id Int @id @default(autoincrement())\n  orderId Int @map("order_id")\n  order Order @relation(fields: [orderId], references: [id])\n  @@map("refunds")\n}\n"""
    pr = othermig.prisma(prisma)
    assert _kinds(pr) == [("create_table", "orders"), ("create_table", "refunds")]
    assert pr[1].table_def["fks"][0]["columns"] == ["order_id"] and pr[1].table_def["fks"][0]["ref_table"] == "orders"
    ts = """export class Refunds1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "refunds" ("id" SERIAL NOT NULL, "order_id" integer NOT NULL, CONSTRAINT "PK_r" PRIMARY KEY ("id"))`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refunds"`);
  }
}"""
    assert _kinds(othermig.js_sql(ts)) == [("create_table", "refunds")]


# ------------------------------------------------------------------ the diff and the risks

def test_the_diff_marks_new_changed_removed_and_renamed():
    before = _apply(sql.parse(BASE_SQL))
    after = _apply(sql.parse(CHANGE_SQL), into=before.copy())
    after.apply(sql.parse("ALTER TABLE order_items RENAME COLUMN sku TO product_sku;")[0], "m2.sql")
    after.apply(sql.parse("ALTER TABLE orders ALTER COLUMN status TYPE varchar(32);")[0], "m2.sql")
    tables = {t["name"]: t for t in diff(before, after, col_renames={("order_items", "sku"): "product_sku"})}
    assert set(tables) == {"refunds", "orders", "shipments", "order_items"}
    assert tables["refunds"]["status"] == "new" and all(c["status"] == "new" for c in tables["refunds"]["columns"])
    orders = {c["name"]: c for c in tables["orders"]["columns"]}
    assert tables["orders"]["status"] == "changed" and orders["refund_total"]["status"] == "new"
    assert orders["status"]["status"] == "changed" and orders["status"]["was"] == "type VARCHAR(20) → varchar(32)"
    assert orders["id"]["status"] == "same"
    ship = {c["name"]: c for c in tables["shipments"]["columns"]}
    assert ship["legacy_code"]["status"] == "removed" and ship["order_id"]["fk"] == "orders.id"
    assert [f["status"] for f in tables["shipments"]["fks"]] == ["new"]
    items = {c["name"]: c for c in tables["order_items"]["columns"]}
    assert items["product_sku"]["status"] == "changed" and items["product_sku"]["was"] == "renamed from sku"
    gone = diff(after, before)
    assert {t["name"]: t["status"] for t in gone}["refunds"] == "removed"


def test_risks_not_null_without_default_fk_without_cleanup_missing_index_and_drops_in_use():
    before = _apply(sql.parse(BASE_SQL), "db/migration/V1__base.sql")
    ops = sql.parse(CHANGE_SQL)
    after = _apply(ops, "db/migration/V2__refunds.sql", into=before.copy())
    steps = [("db/migration/V2__refunds.sql", o) for o in ops]
    found = risks(before, after, steps, lambda name: [{"path": "src/Shipping/ShipmentRepository.php", "line": 12}] if name == "legacy_code" else [])
    by_kind = {r["kind"]: r for r in found}
    assert set(by_kind) == {"not_null_no_default", "fk_no_cleanup", "fk_no_index", "destructive"}
    assert by_kind["not_null_no_default"]["line"] == 8 and by_kind["not_null_no_default"]["severity"] == "high"
    assert "orders.refund_total" in by_kind["not_null_no_default"]["text"]
    assert by_kind["fk_no_cleanup"]["line"] == 9 and "shipments.order_id" in by_kind["fk_no_cleanup"]["text"]
    no_index = [r for r in found if r["kind"] == "fk_no_index"]
    assert {r["text"].split(" for")[0] for r in no_index} == {"no index on refunds.order_id", "no index on shipments.order_id"}
    assert by_kind["destructive"]["line"] == 10 and by_kind["destructive"]["uses"] == [{"path": "src/Shipping/ShipmentRepository.php", "line": 12}]
    # a backfill before the NOT NULL, a default, an index: no risk
    safe = sql.parse("ALTER TABLE orders ADD COLUMN refund_total NUMERIC(10,2) NOT NULL DEFAULT 0;\n"
                     "DELETE FROM shipments WHERE order_id NOT IN (SELECT id FROM orders);\n"
                     "ALTER TABLE shipments ADD CONSTRAINT fk_s FOREIGN KEY (order_id) REFERENCES orders (id);\n"
                     "CREATE INDEX ix_s ON shipments (order_id);")
    after2 = _apply(safe, "V3.sql", into=before.copy())
    assert risks(before, after2, [("V3.sql", o) for o in safe], lambda n: []) == []
    # a new table's NOT NULL column is fine: it has no rows yet
    fresh = sql.parse("CREATE TABLE notes (id INT PRIMARY KEY, body TEXT NOT NULL);")
    assert risks(before, _apply(fresh, into=before.copy()), [("V4.sql", o) for o in fresh], lambda n: []) == []


# ------------------------------------------------------------------ the system graph

def test_system_graph_from_paths_code_and_config():
    files = [
        {"path": "src/Refund/Controller/RefundController.php", "status": "A"},
        {"path": "src/Refund/Service/RefundService.php", "status": "A"},
        {"path": "src/Refund/Repository/RefundRepository.php", "status": "A"},
        {"path": "src/Refund/Messenger/RefundRequestedConsumer.php", "status": "A"},
        {"path": "src/Order/Command/PublishPendingOrdersCommand.php", "status": "M"},
        {"path": "src/Payment/PaymentClient.php", "status": "M"},
        {"path": "db/migration/V2__refunds.sql", "status": "A"},
        {"path": "config/packages/messenger.yaml", "status": "M"},
        {"path": "tests/Refund/RefundServiceTest.php", "status": "A"},
        {"path": "README.md", "status": "M"},
    ]
    texts = {
        "src/Refund/Controller/RefundController.php": "class RefundController { #[Route('/orders/{id}/refunds', methods: ['POST'])]\n"
                                                      "public function create(RefundService $refunds) {} }",
        "src/Refund/Service/RefundService.php": "class RefundService { public function __construct(private RefundRepository $repo, "
                                                "private PaymentClient $payments) {} }",
        "src/Refund/Repository/RefundRepository.php": "class RefundRepository extends ServiceEntityRepository {}",
        "src/Refund/Messenger/RefundRequestedConsumer.php": "#[AsMessageHandler(fromTransport: 'refunds')]\nclass RefundRequestedConsumer {"
                                                            " public function __invoke() { $this->service = RefundService::class; } }\n"
                                                            "// queue: 'refund.requested'",
        "src/Order/Command/PublishPendingOrdersCommand.php": "#[AsCronTask('*/5 * * * *')]\nclass PublishPendingOrdersCommand {"
                                                             " function run() { $this->bus->dispatch(new OrderPlaced()); }\n"
                                                             " // topic: 'order.placed'\n}",
        "src/Payment/PaymentClient.php": "class PaymentClient { const BASE = 'https://payments.example.com/v1'; "
                                         "function refund() { $this->http->request('POST', self::BASE); } }",
        "db/migration/V2__refunds.sql": CHANGE_SQL,
        "config/packages/messenger.yaml": "framework:\n  messenger:\n    transports:\n      refunds:\n        options:\n          queue: 'refund.requested'\n",
        "tests/Refund/RefundServiceTest.php": "class RefundServiceTest {}",
    }
    g = system.build(files, texts, ["refunds", "orders"], None, ["src/Refund/x.php", "src/Shipping/y.php", "web/app.tsx"], {})
    nodes = {n["label"]: n for n in g["nodes"]}
    assert {n["label"]: n["layer"] for n in g["nodes"]} == {
        "RefundController": "http", "RefundService": "service", "RefundRepository": "repository",
        "RefundRequestedConsumer": "consumer", "PublishPendingOrdersCommand": "cron", "PaymentClient": "client",
        "V2__refunds": "migration", "messenger": "config"}
    assert nodes["RefundController"]["area"] == "Refund" and nodes["PublishPendingOrdersCommand"]["area"] == "Order"
    assert nodes["RefundController"]["status"] == "added" and nodes["PaymentClient"]["status"] == "changed"
    assert g["tests"] == 1 and g["skipped"] == 1
    e = {(x["from"], x["to"]): x for x in g["edges"]}
    n = {label: v["id"] for label, v in nodes.items()}
    assert (n["RefundController"], n["RefundService"]) in e and (n["RefundService"], n["RefundRepository"]) in e
    assert (n["RefundService"], n["PaymentClient"]) in e and (n["RefundRequestedConsumer"], n["RefundService"]) in e
    assert (n["RefundRepository"], "x_db") in e and (n["V2__refunds"], "x_db") in e
    assert ("x_http_in", n["RefundController"]) in e and ("x_cron", n["PublishPendingOrdersCommand"]) in e
    assert ("x_q_refund_requested", n["RefundRequestedConsumer"]) in e and (n["PublishPendingOrdersCommand"], "x_q_order_placed") in e
    assert (n["PaymentClient"], "x_h_payments_example_com") in e
    ext = {x["id"]: x for x in g["externals"]}
    assert ext["x_db"]["detail"] == "refunds, orders" and ext["x_h_payments_example_com"]["label"] == "payments.example.com"
    assert g["collapsed"]["label"] == "1 other folder (unchanged)" and g["collapsed"]["names"] == ["web"]
    mm = render.system_mermaid(g)
    assert mm.startswith("flowchart LR\n") and 'subgraph a_Refund["Refund"]' in mm and "class " in mm
    assert '[("Database")]' in mm and "x_q_refund_requested[/\"refund.requested\"/]" in mm
    text = render.system_ascii(g)
    assert "[+] RefundController  (http)" in text and "(queue) refund.requested --> [+] RefundRequestedConsumer (message)" in text
    assert all(ord(ch) < 128 for ch in text)


def test_a_big_change_is_grouped_by_area_and_layer():
    files = [{"path": f"src/Order/Service/S{i}Service.kt", "status": "M"} for i in range(30)] + \
            [{"path": "src/Order/Web/OrderController.kt", "status": "M"}]
    g = system.build(files, {}, [], None, None, {})
    assert {n["label"] for n in g["nodes"]} == {"service ×30", "HTTP handler"} and not g["per_file"]


# ------------------------------------------------------------------ the route, on a demo repository

def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=root, check=True,
                          capture_output=True, text=True).stdout.strip()


def _write(root: Path, files: dict[str, str]):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


@pytest.fixture
def shop(tmp_path):
    root = tmp_path / "shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _write(root, {
        "db/migration/V1__base.sql": BASE_SQL,
        "src/Shipping/ShipmentRepository.php": "<?php\nclass ShipmentRepository {\n  function legacy() {\n"
                                               "    return $this->query('SELECT legacy_code FROM shipments');\n  }\n}\n",
        "src/Order/OrderController.php": "<?php\nclass OrderController {}\n",
        "README.md": "# shop\n",
    })
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    base = _git(root, "rev-parse", "HEAD")
    _git(root, "switch", "-q", "-c", "feat/refunds")
    _write(root, {
        "db/migration/V2__refunds.sql": CHANGE_SQL,
        "src/Refund/RefundController.php": "<?php\n#[Route('/orders/{id}/refunds')]\nclass RefundController {\n"
                                           "  function __construct(private RefundService $refunds) {}\n}\n",
        "src/Refund/RefundService.php": "<?php\nclass RefundService {\n  function __construct(private RefundRepository $repo) {}\n}\n",
        "src/Refund/RefundRepository.php": "<?php\nclass RefundRepository extends ServiceEntityRepository {}\n",
        "src/Entity/Refund.php": "<?php\n#[ORM\\Entity]\nclass Refund {}\n",
        "src/Report/ReportSetup.php": "<?php\nclass ReportSetup {\n  function run() {\n"
                                      "    $this->db->exec('CREATE TABLE report_rows (id INT PRIMARY KEY, total NUMERIC(10,2) NOT NULL)');\n"
                                      "  }\n}\n",
    })
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "refunds")
    head = _git(root, "rev-parse", "HEAD")
    files = [{"path": p, "status": "A"} for p in ["db/migration/V2__refunds.sql", "src/Entity/Refund.php", "src/Refund/RefundController.php",
                                                  "src/Refund/RefundRepository.php", "src/Refund/RefundService.php", "src/Report/ReportSetup.php"]]
    return root, base, head, files


def test_build_on_a_demo_repository(shop):
    root, base, head, files = shop
    out = diagrams.build(str(root), base, head, files)
    db = out["database"]
    assert db["shown"] and db["before"] == "the base branch's migrations" and db["after"] == "the head's migrations"
    st = {t["name"]: t["status"] for t in db["tables"]}
    assert st == {"orders": "changed", "refunds": "new", "report_rows": "new", "shipments": "changed", "order_items": "related"}
    assert db["changes"] == {"new": 2, "changed": 2, "removed": 0}
    assert db["count"] == 5                          # 4 tables + 1 file not read (the entity)
    mig = {m["path"]: m for m in db["migrations"]}
    assert [s["text"] for s in mig["db/migration/V2__refunds.sql"]["steps"]] == [
        "creates table refunds (4 columns, foreign key to orders)",
        "adds column orders.refund_total (NUMERIC(10,2), not null)",
        "adds foreign key shipments.order_id → orders.id",
        "drops column shipments.legacy_code: its data is deleted"]
    assert mig["src/Report/ReportSetup.php"]["framework"] == "SQL in code" and mig["src/Report/ReportSetup.php"]["parsed"]
    assert db["not_parsed"] == [{"path": "src/Entity/Refund.php", "line": 1, "why": "ORM mapping: keel does not read entity classes"}]
    drop = next(r for r in db["risks"] if r["kind"] == "destructive")
    assert drop["uses"] == [{"path": "src/Shipping/ShipmentRepository.php", "line": 4}]
    assert [r["severity"] for r in db["risks"]] == sorted([r["severity"] for r in db["risks"]], key=["high", "medium", "low"].index)
    assert db["mermaid"].startswith("erDiagram\n") and 'refunds["+ refunds"] {' in db["mermaid"]
    assert "orders ||--o{ refunds" in db["mermaid"] and "class refunds,report_rows added" in db["mermaid"]
    assert "[+] refunds" in db["ascii"] and all(ord(ch) < 128 for ch in db["ascii"])
    sysg = out["system"]
    assert {n["label"] for n in sysg["nodes"]} >= {"RefundController", "RefundService", "RefundRepository", "V2__refunds"}
    report = next(n["id"] for n in sysg["nodes"] if n["label"] == "ReportSetup")
    assert {"from": report, "to": "x_db", "label": "changes the schema", "kind": "data"} in sysg["edges"]   # SQL in code
    assert out["text"].startswith("== Database ==") and "== System ==" in out["text"] and "not read (open the file):" in out["text"]


def test_no_database_change_hides_the_tab_and_the_live_schema_is_used_as_before(shop):
    root, base, head, files = shop
    out = diagrams.build(str(root), base, head, [f for f in files if f["path"].startswith("src/Refund/")])
    assert out["database"] == {"shown": False, "count": 0}
    live = {"tables": [{"name": "orders", "columns": [{"name": "id", "type": "bigint", "nullable": False, "pk": True},
                                                        {"name": "total", "type": "numeric", "nullable": False, "pk": False}], "fks": []},
                       {"name": "shipments", "columns": [{"name": "id", "type": "bigint", "nullable": False, "pk": True},
                                                         {"name": "order_id", "type": "bigint", "nullable": False, "pk": False},
                                                         {"name": "legacy_code", "type": "varchar", "nullable": True, "pk": False}], "fks": []}]}
    db = diagrams.build(str(root), base, head, files, live=live, live_name="local")["database"]
    assert db["before"] == "the live database (local)" and db["after"] == "the live database with this change's migrations"
    assert {t["name"]: t["status"] for t in db["tables"]}["refunds"] == "new"
    # the live database that already ran the change: keel uses the base's migrations
    live["tables"].append({"name": "refunds", "columns": [{"name": "id", "type": "bigint", "nullable": False, "pk": True}], "fks": []})
    db = diagrams.build(str(root), base, head, files, live=live, live_name="local")["database"]
    assert db["before"] == "the base branch's migrations" and "already has this change" in db["notes"][0]


def test_a_file_keel_cannot_read_is_listed_never_skipped(shop):
    root, base, head, files = shop
    _write(root, {"db/migration/V3__odd.sql": "FROBNICATE THE orders;\n"})
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "odd")
    head2 = _git(root, "rev-parse", "HEAD")
    db = diagrams.build(str(root), head, head2, [{"path": "db/migration/V3__odd.sql", "status": "A"}])["database"]
    assert db["shown"] and db["not_parsed"] == [{"path": "db/migration/V3__odd.sql", "line": 1, "why": "FROBNICATE THE orders"}]
    assert db["migrations"][0]["parsed"] is False and db["count"] == 1


def test_the_engine_route(client, shop):
    root, base, head, files = shop
    r = client.post("/plugins/review/p1/diagrams", json={"root": str(root), "base": base, "head": head, "files": files})
    assert r.status_code == 200, r.text
    assert r.json()["database"]["shown"] and r.json()["system"]["mermaid"].startswith("flowchart LR")
    bad = client.post("/plugins/review/p1/diagrams", json={"root": str(root), "base": "main; rm", "head": head, "files": files})
    assert bad.status_code == 400
