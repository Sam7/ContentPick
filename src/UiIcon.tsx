import type { TablerIcon } from '@tabler/icons-react';

type UiIconProps = {
  icon: TablerIcon;
  size?: number;
  className?: string;
};

export function UiIcon({ icon: Icon, size = 18, className }: UiIconProps) {
  return <Icon className={className ? `ui-icon ${className}` : 'ui-icon'} size={size} stroke={1.8} aria-hidden="true" focusable="false" />;
}
