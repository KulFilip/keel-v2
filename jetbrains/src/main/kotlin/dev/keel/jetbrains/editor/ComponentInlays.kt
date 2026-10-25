package dev.keel.jetbrains.editor

import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.InlayModel
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.util.Disposer
import com.intellij.util.ui.JBUI
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import javax.swing.JComponent
import javax.swing.SwingUtilities

/**
 * Swing components between the lines of an editor (review threads, KeelBot's "changed lines" bar): a block inlay
 * keeps the room, and the component is laid over it inside the editor's content component. The component reports a
 * change of its size with [relayout].
 */
class ComponentInlays(private val editor: EditorEx, parent: Disposable) : Disposable {
    private val items = LinkedHashMap<Inlay<*>, JComponent>()

    init {
        Disposer.register(parent, this)
        editor.inlayModel.addListener(object : InlayModel.Listener {
            override fun onUpdated(inlay: Inlay<*>, changeFlags: Int) {
                items[inlay]?.let { place(inlay, it) }
            }

            override fun onRemoved(inlay: Inlay<*>) {
                items.remove(inlay)?.let { c ->
                    editor.contentComponent.remove(c)
                    editor.contentComponent.repaint()
                }
            }
        }, this)
        editor.scrollingModel.addVisibleAreaListener({ placeAll() }, this)
        editor.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = SwingUtilities.invokeLater { placeAll() }
        }, this)
        val resize = object : ComponentAdapter() {
            override fun componentResized(e: ComponentEvent) = relayoutAll()
        }
        editor.scrollPane.viewport.addComponentListener(resize)
        Disposer.register(this) { editor.scrollPane.viewport.removeComponentListener(resize) }
    }

    /** Adds [comp] below the line of [offset] (above it with [above]). */
    fun add(offset: Int, comp: JComponent, above: Boolean = false): Inlay<*>? {
        if (editor.isDisposed) return null
        comp.isVisible = true
        val renderer = object : EditorCustomElementRenderer {
            override fun calcWidthInPixels(inlay: Inlay<*>): Int = width()
            override fun calcHeightInPixels(inlay: Inlay<*>): Int = measure(comp)
            override fun paint(inlay: Inlay<*>, g: Graphics, r: Rectangle, textAttributes: TextAttributes) = Unit
        }
        val inlay = editor.inlayModel.addBlockElement(offset, true, above, 1, renderer) ?: return null
        items[inlay] = comp
        editor.contentComponent.add(comp)
        place(inlay, comp)
        return inlay
    }

    /** The component changed (folded, got a message): its inlay takes the new height. */
    fun relayout(comp: JComponent) {
        val inlay = items.entries.firstOrNull { it.value === comp }?.key ?: return
        SwingUtilities.invokeLater { if (inlay.isValid) inlay.update() }
    }

    fun clear() {
        items.keys.toList().forEach { Disposer.dispose(it) }
        items.clear()
    }

    private fun relayoutAll() = items.keys.toList().forEach { if (it.isValid) it.update() }

    private fun placeAll() = items.forEach { (i, c) -> place(i, c) }

    private fun width(): Int {
        val visible = editor.scrollingModel.visibleArea.width
        return (visible - JBUI.scale(24)).coerceIn(JBUI.scale(260), JBUI.scale(820))
    }

    private fun measure(comp: JComponent): Int {
        val w = width()
        comp.setSize(w, Short.MAX_VALUE.toInt())
        comp.doLayout()
        comp.validate()
        return comp.preferredSize.height.coerceAtLeast(JBUI.scale(16))
    }

    private fun place(inlay: Inlay<*>, comp: JComponent) {
        val b = inlay.bounds ?: return
        val x = editor.scrollingModel.visibleArea.x.coerceAtLeast(0) + JBUI.scale(6)
        comp.bounds = Rectangle(x, b.y, width(), b.height)
        comp.revalidate()
        comp.repaint()
    }

    override fun dispose() {
        items.values.forEach { editor.contentComponent.remove(it) }
        items.clear()
    }
}
