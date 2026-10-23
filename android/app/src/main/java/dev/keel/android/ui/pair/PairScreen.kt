package dev.keel.android.ui.pair

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.keel.android.BuildConfig
import dev.keel.android.data.SavedKeel
import dev.keel.android.ui.common.KeelMark
import dev.keel.android.ui.common.PillButton
import dev.keel.android.ui.common.PrimaryButton
import dev.keel.android.ui.common.SectionLabel
import dev.keel.android.ui.theme.K
import dev.keel.android.ui.theme.Mono
import java.util.concurrent.Executors

@Composable
fun PairScreen(vm: PairViewModel, saved: List<SavedKeel>, onBack: (() -> Unit)?) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var scanning by remember { mutableStateOf(false) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> scanning = ok }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = K.c.fg) }
            KeelMark(30.dp, 9.dp)
            Text("Pair with keel", style = MaterialTheme.typography.headlineMedium, color = K.c.fg)
        }
        Text(
            "This phone answers keel's questions, follows its flows, reviews pull requests and chats with KeelBot. " +
                "On the computer, open keel's Settings › Devices › Pair a phone and scan the QR code.",
            fontSize = 15.sp, lineHeight = 22.sp, color = K.c.text2,
        )

        ui.removedFrom?.let { name ->
            Banner("$name removed this phone.", "Pair it again to keep using it with that keel.", K.c.warnSoft, K.c.warnInk)
        }

        if (scanning) {
            QrScanner(onCode = { raw -> scanning = false; vm.fromLink(raw) })
            PillButton("Stop the camera", { scanning = false }, Modifier.fillMaxWidth())
        } else {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 72.dp).clip(RoundedCornerShape(16.dp)).background(K.c.accent)
                    .clickable(role = Role.Button, onClickLabel = "Scan keel's QR code") {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                        else askCamera.launch(Manifest.permission.CAMERA)
                    }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = K.c.onAccent)
                Column {
                    Text("Scan the QR code", color = K.c.onAccent, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text("keel's address and a one-time code", color = K.c.onAccent.copy(alpha = 0.8f), fontSize = 13.sp)
                }
            }
        }

        SectionLabel("Or type them")
        Field("keel's address", ui.url, vm::setUrl, "http://192.168.178.27:8080", KeyboardType.Uri)
        Field("Pairing code", ui.code, vm::setCode, "e.g. 7KQ-4MZ", KeyboardType.Ascii)
        if (ui.error != null) Banner(ui.error!!, ui.hint, K.c.badSoft, K.c.badInk)
        PrimaryButton(if (ui.busy) "Pairing…" else "Pair this phone", vm::pair, busy = ui.busy)
        Text(
            "On the same Wi-Fi as the computer: start keel with keel2 start --wifi. Away from home: a Tailscale address " +
                "(https://<machine>.<tailnet>.ts.net) or a tunnel (https://….trycloudflare.com) works too.",
            fontSize = 13.sp, lineHeight = 19.sp, color = K.c.dim,
        )

        val others = saved.filterNot { it.demo }
        if (others.isNotEmpty()) {
            SectionLabel("Your keels")
            others.forEach { k ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(14.dp)).border(1.dp, K.c.border, RoundedCornerShape(14.dp))
                        .clickable(role = Role.Button, onClickLabel = "Use ${k.name}") { vm.select(k.id) }.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    KeelMark()
                    Column(Modifier.weight(1f)) {
                        Text(k.name, color = K.c.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(k.url, color = K.c.dim, fontSize = 12.sp, fontFamily = Mono)
                    }
                }
            }
        }
        if (BuildConfig.DEMO) {
            PillButton("Try the demo (fake data, no keel needed)", vm::demo, Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, placeholder: String, type: KeyboardType) {
    OutlinedTextField(
        value = value, onValueChange = onChange, singleLine = true,
        label = { Text(label) }, placeholder = { Text(placeholder, color = K.c.dim, fontFamily = Mono) },
        modifier = Modifier.fillMaxWidth(),
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = Mono, color = K.c.fg),
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = K.c.accent, unfocusedBorderColor = K.c.border, focusedLabelColor = K.c.accentInk, cursorColor = K.c.accent),
    )
}

@Composable
fun Banner(title: String, text: String?, bg: androidx.compose.ui.graphics.Color, fg: androidx.compose.ui.graphics.Color) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(bg).padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title, color = fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        if (!text.isNullOrBlank()) Text(text, color = K.c.text2, fontSize = 13.sp, lineHeight = 19.sp)
    }
}

/** CameraX preview + ML Kit's QR reader (its bundled model: no Google Play services needed). */
@Composable
fun QrScanner(onCode: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()) }
    var done by remember { mutableStateOf(false) }
    DisposableEffect(Unit) {
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            scanner.close()
            executor.shutdown()
        }
    }
    Box(
        Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp)).border(2.dp, K.c.accent, RoundedCornerShape(16.dp))
            .semantics { contentDescription = "Camera: point it at keel's QR code" },
    ) {
        AndroidView(factory = { ctx ->
            val view = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(executor) { proxy ->
                    val img = proxy.image
                    if (img == null || done) { proxy.close(); return@setAnalyzer }
                    scanner.process(InputImage.fromMediaImage(img, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            val raw = codes.firstOrNull { it.rawValue?.startsWith("keel:") == true }?.rawValue ?: codes.firstOrNull()?.rawValue
                            if (raw != null && !done) {
                                done = true
                                view.post { onCode(raw) }
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        }, modifier = Modifier.fillMaxSize())
    }
}
