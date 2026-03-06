import {
  BarChart3,
  PieChart,
  Coins,
  Zap,
  TrendingUp,
  Timer,
  Activity,
  type LucideIcon
} from 'lucide-react'
import { lazy, type ComponentType } from 'react'
import type { SessionLineItem, ReportSummary } from '../../../../shared/types/report'

export type WidgetSize = 'small' | 'medium' | 'large'

export interface WidgetProps {
  sessionData: SessionLineItem[]
  summaryData: ReportSummary | null
}

export interface WidgetConfig {
  id: string
  title: string
  icon: LucideIcon
  defaultSize: WidgetSize
  component: ComponentType<WidgetProps>
}

export const SIZE_CONFIG: Record<WidgetSize, { colSpan: number; height: number }> = {
  small: { colSpan: 1, height: 250 },
  medium: { colSpan: 1, height: 350 },
  large: { colSpan: 2, height: 400 }
}

export interface DashboardLayout {
  widgets: { id: string; size: WidgetSize }[]
}

const VALID_SIZES = new Set<string>(['small', 'medium', 'large'])

export function isValidWidgetSize(s: unknown): s is WidgetSize {
  return typeof s === 'string' && VALID_SIZES.has(s)
}

const WIDGET_REGISTRY: readonly WidgetConfig[] = Object.freeze([
  { id: 'daily-hours', title: 'Daily Hours', icon: BarChart3, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/DailyHoursChart')) },
  { id: 'hours-by-project', title: 'Hours by Project', icon: PieChart, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/HoursByProjectChart')) },
  { id: 'hours-by-client', title: 'Hours by Client', icon: PieChart, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/HoursByClientChart')) },
  { id: 'token-usage', title: 'Token Usage', icon: Zap, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/TokenUsageChart')) },
  { id: 'prompts-per-day', title: 'Prompts per Day', icon: TrendingUp, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/PromptsPerDayChart')) },
  { id: 'billable-earnings', title: 'Billable Earnings', icon: Coins, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/BillableEarningsChart')) },
  { id: 'session-length', title: 'Session Length', icon: Timer, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/SessionLengthChart')) },
  { id: 'peak-hours', title: 'Peak Hours', icon: Activity, defaultSize: 'medium' as WidgetSize, component: lazy(() => import('./widgets/PeakHoursChart')) }
]) as unknown as WidgetConfig[]

export { WIDGET_REGISTRY }

export const DEFAULT_LAYOUT: DashboardLayout = {
  widgets: WIDGET_REGISTRY.map((w) => ({ id: w.id, size: w.defaultSize }))
}
