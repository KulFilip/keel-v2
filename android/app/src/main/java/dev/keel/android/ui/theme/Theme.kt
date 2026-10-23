package dev.keel.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** keel's colours (web/src/styles.css): the dark theme from the approved mockup, the light one from the web's tokens. */
@Immutable
data class KeelColors(
    val dark: Boolean,
    val bg: Color, val panel: Color, val panel2: Color, val border: Color,
    val fg: Color, val dim: Color, val text2: Color, val body: Color,
    val accent: Color, val accentSoft: Color, val accentInk: Color, val onAccent: Color, val accentBorder: Color,
    val ok: Color, val okSoft: Color, val okInk: Color,
    val run: Color, val runSoft: Color, val runInk: Color,
    val warn: Color, val warnSoft: Color, val warnInk: Color,
    val bad: Color, val badSoft: Color, val badInk: Color, val badBorder: Color, val badTint: Color,
    val checkBg: Color, val checkBorder: Color, val mineBg: Color, val codeChip: Color, val codeChipInk: Color,
)

val DarkKeel = KeelColors(
    dark = true,
    bg = Color(0xFF131314), panel = Color(0xFF1A1A1C), panel2 = Color(0xFF222225), border = Color(0xFF2C2C30),
    fg = Color(0xFFF7F6F3), dim = Color(0xFF9A958C), text2 = Color(0xFFC9C5BD), body = Color(0xFFE6E3DC),
    accent = Color(0xFFA48BFF), accentSoft = Color(0xFF2A2342), accentInk = Color(0xFFC4B5FF), onAccent = Color(0xFF131314),
    accentBorder = Color(0xFF3A3150),
    ok = Color(0xFF4EC07C), okSoft = Color(0xFF173225), okInk = Color(0xFF6FDC8F),
    run = Color(0xFF57AEFF), runSoft = Color(0xFF142A3D), runInk = Color(0xFF9FD0FF),
    warn = Color(0xFFE0A13A), warnSoft = Color(0xFF36290F), warnInk = Color(0xFFF2C46D),
    bad = Color(0xFFF0685A), badSoft = Color(0xFF3A1D1A), badInk = Color(0xFFF59A8F), badBorder = Color(0xFF4A2723),
    badTint = Color(0xFF201615),
    checkBg = Color(0xFF1C1828), checkBorder = Color(0xFF5A4A9A), mineBg = Color(0xFF201C2C),
    codeChip = Color(0xFF2F2A1C), codeChipInk = Color(0xFFF2C46D),
)

val LightKeel = KeelColors(
    dark = false,
    bg = Color(0xFFF7F6F3), panel = Color(0xFFFFFFFF), panel2 = Color(0xFFF1EFEA), border = Color(0xFFE3E0D9),
    fg = Color(0xFF131314), dim = Color(0xFF6F6B63), text2 = Color(0xFF4F4B44), body = Color(0xFF2A2824),
    accent = Color(0xFF7A5CFF), accentSoft = Color(0xFFECE6FF), accentInk = Color(0xFF5B3FE0), onAccent = Color(0xFFFFFFFF),
    accentBorder = Color(0xFFD5CBFF),
    ok = Color(0xFF1F8A4C), okSoft = Color(0xFFE3F3E9), okInk = Color(0xFF1F8A4C),
    run = Color(0xFF0B74C4), runSoft = Color(0xFFE2EFFA), runInk = Color(0xFF0B74C4),
    warn = Color(0xFFB26A00), warnSoft = Color(0xFFFBEFD9), warnInk = Color(0xFF9A5C00),
    bad = Color(0xFFC0392B), badSoft = Color(0xFFF8E1DE), badInk = Color(0xFFB0352A), badBorder = Color(0xFFEFC6C0),
    badTint = Color(0xFFFDF3F1),
    checkBg = Color(0xFFF6F2FF), checkBorder = Color(0xFFC9BCFF), mineBg = Color(0xFFF3EFFC),
    codeChip = Color(0xFFFBEFD9), codeChipInk = Color(0xFF9A5C00),
)

val LocalKeel = staticCompositionLocalOf { DarkKeel }

/** The sans the mockup names (Inter) is not bundled: the system sans is close; keys and paths use the monospace. */
val Mono = FontFamily.Monospace

object K {
    val c: KeelColors @Composable get() = LocalKeel.current
}

@Composable
fun KeelTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val k = if (dark) DarkKeel else LightKeel
    val scheme = if (dark) {
        darkColorScheme(
            primary = k.accent, onPrimary = k.onAccent, primaryContainer = k.accentSoft, onPrimaryContainer = k.accentInk,
            secondary = k.accentInk, background = k.bg, onBackground = k.fg, surface = k.bg, onSurface = k.fg,
            surfaceVariant = k.panel2, onSurfaceVariant = k.dim, surfaceContainer = k.panel, surfaceContainerHigh = k.panel2,
            surfaceContainerLow = k.panel, outline = k.border, outlineVariant = k.border, error = k.bad, onError = k.onAccent,
            secondaryContainer = k.accentSoft, onSecondaryContainer = k.accentInk,
        )
    } else {
        lightColorScheme(
            primary = k.accent, onPrimary = k.onAccent, primaryContainer = k.accentSoft, onPrimaryContainer = k.accentInk,
            secondary = k.accentInk, background = k.bg, onBackground = k.fg, surface = k.bg, onSurface = k.fg,
            surfaceVariant = k.panel2, onSurfaceVariant = k.dim, surfaceContainer = k.panel, surfaceContainerHigh = k.panel2,
            surfaceContainerLow = k.panel, outline = k.border, outlineVariant = k.border, error = k.bad, onError = k.onAccent,
            secondaryContainer = k.accentSoft, onSecondaryContainer = k.accentInk,
        )
    }
    val base = Typography()
    val type = base.copy(
        headlineMedium = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
        titleLarge = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 21.sp),
        bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
        labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
    )
    CompositionLocalProvider(LocalKeel provides k) {
        MaterialTheme(colorScheme = scheme, typography = type, content = content)
    }
}
