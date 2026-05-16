export function createLightweightInsights(memories: Array<Record<string, unknown>>) {
  const topicCounts = new Map<string, number>();
  let strained = 0;

  for (const memory of memories) {
    for (const topic of (memory.recurring_topics as string[] | undefined) ?? []) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
    if (memory.emotional_state === "strained") strained += 1;
  }

  const recurringThemes = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));

  return {
    moodTrend: strained > memories.length / 3 ? "Stress signals are elevated recently." : "Mood signals look steady.",
    recurringThemes,
    weeklyReflection:
      recurringThemes.length > 0
        ? `You keep returning to ${recurringThemes.map((theme) => theme.topic).join(", ")}.`
        : "No strong recurring theme yet. Capture a little more and patterns will emerge.",
    forgottenGoals: memories
      .filter((memory) => Array.isArray(memory.goals) && (memory.goals as unknown[]).length > 0)
      .slice(0, 3)
      .map((memory) => memory.summary)
  };
}
