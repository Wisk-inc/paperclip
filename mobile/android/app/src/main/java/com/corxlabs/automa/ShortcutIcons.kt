package com.corxlabs.automa

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * Launcher shortcut icons, drawn at run time as adaptive bitmaps: a graphite
 * tile with a soft tinted glow behind a white glyph. The launcher masks the
 * tile to its own shape (circle, squircle, …) exactly like the app icon,
 * instead of dropping a flat glyph onto a white disc, which is what it does
 * with a plain drawable.
 */
object ShortcutIcons {
    fun tile(context: Context, glyph: Int, tint: Int): IconCompat {
        val density = context.resources.displayMetrics.density
        val size = (108 * density).toInt().coerceIn(216, 432)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val s = size.toFloat()
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        // Graphite base, darker at the bottom.
        paint.shader = LinearGradient(0f, 0f, 0f, s, 0xFF26262B.toInt(), 0xFF09090B.toInt(), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, s, s, paint)
        // The tinted glow sits behind the glyph, a little above centre.
        paint.shader = RadialGradient(
            s * 0.5f, s * 0.40f, s * 0.58f,
            intArrayOf(alpha(tint, 0.92f), alpha(tint, 0.38f), alpha(tint, 0f)),
            floatArrayOf(0f, 0.42f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, s, s, paint)
        // A thin highlight along the top edge keeps the tile from reading flat.
        paint.shader = LinearGradient(0f, 0f, 0f, s * 0.45f, alpha(Color.WHITE, 0.16f), alpha(Color.WHITE, 0f), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, s, s * 0.45f, paint)

        // The glyph, white, inside the adaptive safe zone (the centre 66%).
        ContextCompat.getDrawable(context, glyph)?.mutate()?.let { drawable ->
            val wrapped = DrawableCompat.wrap(drawable)
            DrawableCompat.setTint(wrapped, Color.WHITE)
            val inset = (s * 0.30f).toInt()
            wrapped.setBounds(inset, inset, size - inset, size - inset)
            wrapped.draw(canvas)
        }
        return IconCompat.createWithAdaptiveBitmap(bitmap)
    }

    private fun alpha(color: Int, fraction: Float): Int =
        Color.argb((255 * fraction).toInt().coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
}
