import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// 시간대: KST(Asia/Seoul), 매시 55분
export const fetchAndBroadcastFNG = functions
  .region("asia-northeast3") // 서울 리전 권장
  .pubsub.schedule("55 * * * *")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const CNN_URL =
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
    const BACKUP_URL =
      "https://thinker89.github.io/docs_hub/project_market_mood/api/cnn_api.json";

    type CnnShape = {
      fear_and_greed?: { score?: number; rating?: string; timestamp?: string };
    };

    const fetchJson = async (url: string): Promise<CnnShape> => {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
      return (await res.json()) as CnnShape;
    };

    let score: number | undefined;
    let timestamp: string | undefined;
    let source: "cnn" | "github" = "cnn";

    try {
      // 1차: CNN
      const j = await fetchJson(CNN_URL);
      score = j?.fear_and_greed?.score;
      timestamp = j?.fear_and_greed?.timestamp;
      if (typeof score !== "number" || !timestamp) {
        throw new Error("CNN payload missing fields");
      }
    } catch (e) {
      console.warn("[FNG] CNN fetch failed, fallback to GitHub:", (e as any)?.message);
      // 2차: GitHub 백업
      const j2 = await fetchJson(BACKUP_URL);
      score = j2?.fear_and_greed?.score;
      timestamp = j2?.fear_and_greed?.timestamp;
      source = "github";
      if (typeof score !== "number" || !timestamp) {
        throw new Error("Backup payload missing fields");
      }
    }

    // Firestore 문서 1개 덮어쓰기
    await db.collection("fng").doc("latest").set(
      {
        score,
        timestamp,   // 원문 UTC 문자열 그대로 보관
        source,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // FCM data-only 팬아웃 (토픽: fng-all)
    // 앱에서 data-only로 받아 캐시에 저장만 하게 함 (사일런트 푸쉬)
    await messaging.send({
      topic: "fng-all",
      data: {
        score: String(score),
        timestamp: String(timestamp),
        source,
      },
      android: { priority: "high" },
      apns: {
        headers: { "apns-push-type": "background", "apns-priority": "5" },
        payload: { aps: { "content-available": 1 } },
      },
    });

    console.log("[FNG] updated & broadcast", { score, timestamp, source });
    return null;
  });
