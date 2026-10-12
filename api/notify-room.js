package com.push.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class NotifyService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        String title = "Clashxwar";
        String body = "";
        Map<String, String> d = msg.getData();
        if (d != null) {
            if (d.get("title") != null) title = d.get("title");
            if (d.get("body") != null) body = d.get("body");
        }
        show(title, body);
    }

    private void show(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        String ch = "match_updates";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(ch, "Match updates", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(c);
