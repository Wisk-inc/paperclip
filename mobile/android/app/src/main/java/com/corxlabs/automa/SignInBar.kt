package com.corxlabs.automa

import android.content.Context
import android.graphics.Color
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The strip above a connector's sign-in page while it runs in the app (see
 * [SignInLinks]). The app shows no address bar, so this names the site the
 * person is typing into, and Cancel goes back to the board.
 */
class SignInBar(context: Context, onCancel: () -> Unit) : LinearLayout(context) {
    private val label = TextView(context)

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setBackgroundColor(Color.rgb(24, 24, 27))
        setPadding(dp(16), dp(4), dp(4), dp(4))
        label.apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
        }
        val cancel = Button(context).apply {
            text = context.getString(R.string.sign_in_cancel)
            isAllCaps = false
            setBackgroundColor(Color.TRANSPARENT)
            setTextColor(Color.WHITE)
            setOnClickListener { onCancel() }
        }
        addView(label, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(cancel, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    fun show(host: String) {
        label.text = context.getString(R.string.sign_in_at, host)
        contentDescription = label.text
    }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()
}
