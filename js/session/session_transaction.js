export async function run_restore_stages(stages, on_failure) {
  const completed = [];
  for (const stage of stages) {
    try {
      await stage.run();
      completed.push(stage.name);
    } catch (error) {
      await on_failure?.({ error, stage: stage.name, completed: [...completed] });
      error.restore_stage = stage.name;
      throw error;
    }
  }
  return completed;
}
