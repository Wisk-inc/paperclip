package com.corxlabs.automa

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.CountDownTimer
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The native sheet shown over the board when the phone has no network, or
 * when the Automa server does not answer: the page underneath stays as it
 * was, so nothing typed is lost, and the sheet counts down to the next try
 * instead of leaving a dead white page. A server on this phone never shows
 * it (the connect screen waits for Termux instead, see MainActivity).
 */
class ConnectionOverlay(context: Context, private val onRetry: () -> Unit) : FrameLayout(context) {
    enum class Reason { OFFLINE, UNREACHABLE }

    var reason: Reason = Reason.OFFLINE
        private set

    private val title = TextView(context)
    private val message = TextView(context)
    private val countdown = TextView(context)
    private val retry = Button(context)
    private var timer: CountDownTimer? = null

    init {
        setBackgroundColor(Color.argb(242, 0, 0, 0))
        isClickable = true
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val pad = dp(28)
            setPadding(pad, pad, pad, pad)
        }
        title.apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        message.apply {
            setTextColor(Color.argb(200, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        }
        countdown.apply {
            setTextColor(Color.argb(160, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, 0)
        }
        retry.apply {
            text = context.getString(R.string.offline_retry)
            setOnClickListener { timer?.cancel(); onRetry() }
            setPadding(dp(24), dp(12), dp(24), dp(12))
        }
        column.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(countdown, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(
            retry,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(22) },
        )
        addView(column, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    /** Shows the sheet; with [retryInSeconds] > 0 it counts down and retries by itself. */
    fun show(reason: Reason, detail: String?, retryInSeconds: Int) {
        this.reason = reason
        timer?.cancel()
        val res = context.resources
        when (reason) {
            Reason.OFFLINE -> {
                title.text = res.getString(R.string.offline_title)
                message.text = res.getString(R.string.offline_message)
                countdown.text = res.getString(R.string.offline_waiting)
            }
            Reason.UNREACHABLE -> {
                title.text = res.getString(R.string.unreachable_title)
                message.text = listOfNotNull(res.getString(R.string.unreachable_message), detail).joinToString("\n\n")
            }
        }
        if (retryInSeconds > 0) {
            timer = object : CountDownTimer(retryInSeconds * 1000L, 500L) {
                override fun onTick(millisUntilFinished: Long) {
                    val seconds = ((millisUntilFinished + 999) / 1000).toInt()
                    countdown.text = res.getQuantityString(R.plurals.retry_in_seconds, seconds, seconds)
                }
                override fun onFinish() {
                    countdown.text = res.getString(R.string.retrying_now)
                    onRetry()
                }
            }.start()
        }
    }

    override fun onDetachedFromWindow() {
        timer?.cancel()
        timer = null
        super.onDetachedFromWindow()
    }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()
}
