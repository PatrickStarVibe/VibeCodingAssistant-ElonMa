import type { AllowedAction, WorkflowStatus } from './types.js';

const ASK_STATUS_SUMMARY: AllowedAction[] = [
  { id: 'status', description: '查看当前任务状态。' },
  { id: 'summary', description: '总结当前任务和最近产物。' },
  { id: 'ask', description: '询问当前任务、计划、风险、实现、产物，或请求查看/发送某个 artifact。' },
];

const STOP: AllowedAction = { id: 'stop', description: '停止当前任务。' };

export function getAllowedActions(state: { status: WorkflowStatus }): AllowedAction[] {
  switch (state.status) {
    case 'awaiting_brief_confirmation':
      return [
        { id: 'approve', description: '确认 brief，进入难度选择；可以附带给后续 agent 的执行约束或原文使用要求。' },
        { id: 'difficulty', description: '确认 brief 并直接选择 low、medium 或 high 难度；可以附带给后续 agent 的执行约束。' },
        { id: 'revise', description: '指出 brief 中需要修正的地方。' },
        { id: 'reject', description: '拒绝 brief 并停止任务。' },
        STOP,
        ...ASK_STATUS_SUMMARY,
      ];
    case 'awaiting_difficulty_selection':
      return [
        { id: 'difficulty', description: '选择 low、medium 或 high 难度；可以附带给后续 agent 的执行约束。' },
        STOP,
        ...ASK_STATUS_SUMMARY,
      ];
    case 'ready_for_decision':
    case 'waiting_user_direction':
      return [
        { id: 'approve', description: '批准当前方案并继续推进；可以附带后续实现约束。' },
        { id: 'revise', description: '提出修改意见，回到规划阶段。' },
        { id: 'reject', description: '拒绝当前方案并停止任务。' },
        STOP,
        ...ASK_STATUS_SUMMARY,
      ];
    case 'implementation_approved':
      return [
        { id: 'approve', description: '继续已批准的实现路线。' },
        STOP,
        ...ASK_STATUS_SUMMARY,
      ];
    case 'awaiting_user_acceptance':
      return [
        { id: 'accept', description: '验收通过，生成 task-record 并完成任务。' },
        { id: 'revise', description: '验收前要求继续修改。' },
        { id: 'note', description: '记录验收备注但暂不完成。' },
        ...ASK_STATUS_SUMMARY,
      ];
    case 'completed':
    case 'stopped':
      return ASK_STATUS_SUMMARY;
    case 'created':
    case 'briefing':
    case 'planning_requested':
    case 'planning':
    case 'task_artifacts_persisting':
    case 'execution_queue_ready':
    case 'implementing':
    case 'execution_unit_implementing':
    case 'execution_unit_testing':
    case 'execution_unit_result_recording':
    case 'next_execution_unit_or_all_done':
    case 'implemented':
    case 'final_reviewing':
    case 'final_review_routing':
    case 'task_recording':
      return [STOP, ...ASK_STATUS_SUMMARY];
  }
}

export function humanStageName(status: WorkflowStatus): string {
  switch (status) {
    case 'created':
      return '任务已创建';
    case 'briefing':
      return '生成 brief';
    case 'awaiting_brief_confirmation':
      return '等你确认 brief';
    case 'awaiting_difficulty_selection':
      return '等你选择难度';
    case 'planning_requested':
      return '准备规划';
    case 'planning':
      return '规划中';
    case 'task_artifacts_persisting':
      return '保存任务产物';
    case 'execution_queue_ready':
      return '执行队列已准备';
    case 'waiting_user_direction':
      return '等你决定方向';
    case 'ready_for_decision':
      return '等你批准方案';
    case 'implementation_approved':
      return '实现已批准';
    case 'implementing':
      return '实现中';
    case 'execution_unit_implementing':
      return '执行单元实现中';
    case 'execution_unit_testing':
      return '执行单元测试中';
    case 'execution_unit_result_recording':
      return '记录执行结果';
    case 'next_execution_unit_or_all_done':
      return '检查下一执行单元';
    case 'implemented':
      return '实现已完成';
    case 'final_reviewing':
      return '最终 review 中';
    case 'final_review_routing':
      return '最终 review 路由中';
    case 'awaiting_user_acceptance':
      return '等你验收';
    case 'task_recording':
      return '生成 task-record';
    case 'completed':
      return '已完成';
    case 'stopped':
      return '已停止';
  }
}
