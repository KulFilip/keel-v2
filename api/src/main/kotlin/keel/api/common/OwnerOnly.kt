package keel.api.common

import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions

/** Files that hold a key or a token: created readable by the owner only from the first byte (no moment with open rights). */
object OwnerOnly {
    private val perms = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))

    /** Creates [path] (it must not exist) with mode 600 where the disk has Unix rights, and writes [bytes]. */
    fun create(path: Path, bytes: ByteArray) {
        val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        val posix = path.fileSystem.supportedFileAttributeViews().contains("posix")
        val channel = if (posix) Files.newByteChannel(path, options, perms) else Files.newByteChannel(path, options)
        channel.use { it.write(ByteBuffer.wrap(bytes)) }
    }
}
