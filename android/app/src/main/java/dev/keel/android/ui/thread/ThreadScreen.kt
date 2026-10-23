package dev.keel.android.ui.thread

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.keel.android.data.AiRun
import dev.keel.android.data.DiffLine
import dev.keel.android.data.ReviewThread
import dev.keel.android.data.ago
import dev.keel.android.data.initials
import dev.keel.android.data.verdictLabel
import dev.keel.android.ui.common.Avatar
import dev.keel.android.ui.common.DetailBar
import dev.keel.android.ui.common.Dot
import dev.keel.android.ui.common.EmptyState
import dev.keel.android.ui.common.ErrorState
import dev.keel.android.ui.common.InlineError
import dev.keel.android.ui.common.KCard
import dev.keel.android.ui.common.KeelMark
import dev.keel.android.ui.common.Loading
import dev.keel.android.ui.common.PillButton
import dev.keel.android.ui.common.Tag
import dev.keel.android.ui.pair.Banner
import dev.keel.android.ui.theme.K
import dev.keel.android.ui.theme.Mono

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(vm: ThreadViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val v = ui.view
    val context = LocalContext.current
    val checks = v?.checks.orEmpty()
    val passed = checks.count { it.state.lowercase() in setOf("success", "passed", "neutral", "skipped") }
    val checksText = if (checks.isEmpty()) "" else if (passed == checks.size) "checks ✓ $passed/${checks.size}" else "checks ✕ ${checks.size - passed} failed"
    Column(Modifier.fillMaxSize()) {
        DetailBar(
            v?.let { "#${it.number ?: ""} ${it.title}" } ?: "Pull request",
            v?.let { listOfNotNull(it.branch.substringAfterLast('/').ifBlank { null }, checksText.ifBlank { null }).joinToString(" · ") },
            onBack, "Back to the pull requests",
        ) {
            v?.url?.let { url ->
                IconButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open on ${if (v.host?.kind == "gitlab") "GitLab" else "GitHub"}", tint = K.c.fg)
                }
            }
        }
        val tabs = listOf(PrTab.THREADS to "Threads ${ui.open.size}", PrTab.FILES to "Files ${v?.files?.size ?: 0}", PrTab.CHECKS to "Checks")
        TabRow(
            selectedTabIndex = ui.tab.ordinal, containerColor = K.c.bg, contentColor = K.c.fg,
            indicator = { pos -> TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(pos[ui.tab.ordinal]), height = 3.dp, color = K.c.accent) },
            divider = { HorizontalDivider(color = K.c.border) },
        ) {
            tabs.forEach { (t, label) ->
                Tab(selected = ui.tab == t, onClick = { vm.setTab(t) }, modifier = Modifier.height(48.dp),
                    text = { Text(label, fontSize = 14.sp, fontWeight = if (ui.tab == t) FontWeight.SemiBold else FontWeight.Medium, color = if (ui.tab == t) K.c.fg else K.c.dim) })
            }
        }
        PullToRefreshBox(isRefreshing = ui.refreshing, onRefresh = vm::refresh, modifier = Modifier.weight(1f)) {
            when {
                ui.loading -> Loading()
                ui.error != null -> ErrorState(ui.error!!, { vm.load() })
                v == null -> EmptyState("Not found", "keel cannot find this pull request.")
                else -> Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ui.note?.let { Banner(it, null, K.c.okSoft, K.c.okInk) }
                    InlineError(ui.actionError, vm::clearNote)
                    when (ui.tab) {
                        PrTab.THREADS -> Threads(ui, vm)
                        PrTab.FILES -> v.files.forEach { f ->
                            KCard(padding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
                                Text(f.path, fontFamily = Mono, fontSize = 13.sp, color = K.c.fg)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(f.status, fontSize = 12.sp, color = K.c.dim)
                                    Text("+${f.added}", fontSize = 12.sp, color = K.c.okInk, fontFamily = Mono)
                                    Text("−${f.removed}", fontSize = 12.sp, color = K.c.badInk, fontFamily = Mono)
                                }
                            }
                        }
                        PrTab.CHECKS -> {
                            if (checks.isEmpty()) EmptyState("No checks", "This pull request has no CI checks.")
                            checks.forEach { c ->
                                val ok = c.state.lowercase() in setOf("success", "passed", "neutral", "skipped")
                                val running = c.state.lowercase() in setOf("pending", "queued", "in_progress", "running")
                                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Dot(if (ok) K.c.ok else if (running) K.c.run else K.c.bad)
                                    Text(c.name, fontSize = 14.sp, color = K.c.fg, modifier = Modifier.weight(1f))
                                    Text(c.state, fontSize = 12.sp, color = K.c.dim, fontFamily = Mono)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (ui.tab == PrTab.THREADS && ui.current != null) ThreadFooter(ui, vm)
    }
}

@Composable
private fun Threads(ui: ThreadUi, vm: ThreadViewModel) {
    if (ui.open.isEmpty() && ui.resolved.isEmpty()) EmptyState("No threads", "Nobody commented on this pull request yet.")
    ui.open.forEach { t -> ThreadCard(t, ui, vm, selected = t.id == ui.current?.id) }
    ui.resolved.forEach { t -> ResolvedRow(t) }
}

@Composable
private fun ThreadCard(t: ReviewThread, ui: ThreadUi, vm: ThreadViewModel, selected: Boolean) {
    KCard(
        border = if (selected) K.c.accent else K.c.border,
        padding = androidx.compose.foundation.layout.PaddingValues(14.dp),
        onClick = if (selected) null else ({ vm.select(t.id) }),
        clickLabel = "Pick this thread",
        modifier = Modifier.semantics { stateDescription = if (selected) "picked: the buttons below act on it" else "" },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.waitsForMe(t)) Tag("Waiting for you", K.c.warnSoft, K.c.warnInk) else Tag("Open", K.c.panel2, K.c.text2)
            val where = listOfNotNull(t.path?.let { shortPath(it) }, t.line?.let { l -> if (t.startLine != null && t.startLine != l) "${t.startLine}–$l" else "$l" }).joinToString(":")
            Text(where, fontFamily = Mono, fontSize = 12.sp, color = K.c.dim, maxLines = 2)
        }
        ui.snippets[t.id]?.takeIf { it.isNotEmpty() }?.let { Snippet(it) }
        t.comments.forEach { c ->
            val mine = c.author == ui.me
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (mine) K.c.mineBg else Color.Transparent).padding(if (mine) 10.dp else 0.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Avatar(initials(c.author), if (mine) K.c.accentSoft else K.c.runSoft, if (mine) K.c.accentInk else K.c.runInk, 30.dp)
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text((if (mine) "you" else c.author) + "  · ${ago(c.at)}", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = K.c.fg)
                    SelectionContainer { Text(c.body, fontSize = 14.sp, lineHeight = 21.sp, color = K.c.body) }
                }
            }
        }
        val run = ui.ai.judges[t.id]
        if (run != null && t.id !in ui.dismissed) CheckCard(t.id, run, vm, busy = ui.busy == "judge")
        ui.ai.addressed[t.id]?.let { a -> Text("keel addresses it: ${a.title}${a.branch?.let { b -> " · $b" } ?: ""}", fontSize = 12.sp, color = K.c.okInk) }
    }
}

private fun shortPath(p: String): String {
    val parts = p.split('/')
    return if (parts.size <= 3) p else "${parts.first()}/…/${parts.last()}"
}

@Composable
private fun Snippet(lines: List<DiffLine>) {
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(K.c.bg).border(1.dp, K.c.border, shape).horizontalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        lines.forEach { l ->
            val (bg, fg) = when (l.mark) {
                '+' -> K.c.okSoft to K.c.okInk
                '-' -> K.c.badSoft to K.c.badInk
                else -> Color.Transparent to K.c.dim
            }
            Text(
                "${(l.number?.toString() ?: "").padStart(3)}${l.mark} ${l.text}",
                fontFamily = Mono, fontSize = 12.sp, lineHeight = 19.sp, color = fg, maxLines = 1, softWrap = false,
                modifier = Modifier.background(bg).padding(horizontal = 10.dp),
            )
        }
    }
}

/** keel's answer to "Is the reviewer right?": the verdict, why, the fix, and what to do with it. */
@Composable
private fun CheckCard(threadId: String, run: AiRun, vm: ThreadViewModel, busy: Boolean) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(K.c.checkBg).border(1.dp, K.c.checkBorder, shape).padding(12.dp).semantics { contentDescription = "keel's check" },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KeelMark(26.dp, 8.dp)
            Text(if (run.status == "running") "keel checks the code…" else if (run.status == "failed") "keel's check failed" else "keel checked the code",
                fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = K.c.accentInk, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.dismiss(threadId) }, modifier = Modifier.size(44.dp)) { Icon(Icons.Outlined.Close, contentDescription = "Dismiss keel's check", tint = K.c.dim) }
        }
        val r = run.result
        if (r != null) {
            val meta = listOfNotNull(r.tokens?.let { "~${(it + 500) / 1000}k tokens" }, r.model, r.effort).joinToString(" · ")
            if (meta.isNotBlank()) Text(meta, fontFamily = Mono, fontSize = 11.sp, color = K.c.dim)
            r.items.forEach { item ->
                val (soft, ink) = when (item.verdict) {
                    "reviewer_right" -> K.c.okSoft to K.c.okInk
                    "author_right" -> K.c.runSoft to K.c.runInk
                    "partly" -> K.c.warnSoft to K.c.warnInk
                    else -> K.c.border to K.c.text2
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Tag(verdictLabel(item.verdict), soft, ink, upper = true)
                    Text(item.why, fontSize = 14.sp, lineHeight = 21.sp, color = K.c.body)
                    item.fix?.takeIf { it.isNotBlank() }?.let { Text("Fix: $it", fontSize = 13.sp, lineHeight = 19.sp, color = K.c.dim) }
                }
            }
            if (r.items.isEmpty() && !r.text.isNullOrBlank()) Text(r.text, fontSize = 14.sp, color = K.c.body)
        }
        run.error?.let { Text(it, fontSize = 13.sp, color = K.c.badInk) }
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (r?.reply != null || r?.items?.firstOrNull()?.fix != null) PillButton("Use as my reply", { vm.useAsReply(threadId) }, filled = true, height = 44.dp)
            if (run.status != "running") PillButton("Check deeper", { vm.judge(threadId, harder = true) }, enabled = !busy, height = 44.dp)
            PillButton("Dismiss", { vm.dismiss(threadId) }, height = 44.dp)
        }
    }
}

@Composable
private fun ResolvedRow(t: ReviewThread) {
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, K.c.border, shape)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button, onClickLabel = if (open) "Fold" else "Unfold") { open = !open }
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (open) "▾" else "▸", color = K.c.dim)
            Box(Modifier.size(8.dp).clip(CircleShape).background(K.c.ok))
            val first = t.comments.firstOrNull()
            Text("${first?.author ?: ""} · “${first?.body?.lineSequence()?.firstOrNull().orEmpty()}”", fontSize = 14.sp, color = K.c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("Resolved", fontSize = 12.sp, color = K.c.okInk)
        }
        if (open) Column(Modifier.padding(start = 34.dp, end = 14.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            t.comments.drop(1).forEach { c -> Text("${c.author}: ${c.body}", fontSize = 14.sp, lineHeight = 20.sp, color = K.c.text2) }
        }
    }
}

@Composable
private fun ThreadFooter(ui: ThreadUi, vm: ThreadViewModel) {
    val t = ui.current ?: return
    val other = t.comments.lastOrNull { it.author != ui.me }?.author ?: t.comments.firstOrNull()?.author ?: "the thread"
    Column(Modifier.fillMaxWidth().background(K.c.panel).padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton(if (ui.busy == "judge") "✦ Checking…" else "✦ Right?", { vm.judge(t.id) }, Modifier.weight(1f), tinted = true, enabled = ui.busy == null, corner = 12.dp)
            PillButton(if (ui.busy == "address") "✦ Starting…" else "✦ Address it", { vm.address(t.id) }, Modifier.weight(1f), tinted = true, enabled = ui.busy == null, corner = 12.dp)
            PillButton("Resolve", { vm.resolve(t.id) }, Modifier.weight(1f), enabled = ui.busy == null, corner = 12.dp)
        }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(K.c.bg).border(1.dp, K.c.border, RoundedCornerShape(24.dp)).padding(start = 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextField(
                value = ui.reply, onValueChange = vm::setReply, modifier = Modifier.weight(1f).semantics { contentDescription = "Reply to $other" },
                placeholder = { Text("Reply to $other…", color = K.c.dim) }, maxLines = 5,
                colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = K.c.accent, focusedTextColor = K.c.fg, unfocusedTextColor = K.c.fg),
            )
            IconButton(
                onClick = vm::sendReply, enabled = ui.reply.isNotBlank() && ui.busy == null,
                colors = IconButtonDefaults.iconButtonColors(containerColor = K.c.accent, contentColor = K.c.onAccent, disabledContainerColor = K.c.accent.copy(alpha = 0.4f), disabledContentColor = K.c.onAccent),
                modifier = Modifier.size(44.dp),
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send the reply", modifier = Modifier.size(20.dp)) }
        }
    }
}
