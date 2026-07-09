import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  children,
  className,
  icon,
  size = "md",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      className={cn("hs-button", `hs-button--${variant}`, `hs-button--${size}`, className)}
      type={type}
      {...props}
    >
      {icon ? <span className="hs-button__icon">{icon}</span> : null}
      <span className="hs-button__label">{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  selected?: boolean;
}

export function IconButton({
  "aria-pressed": ariaPressed,
  className,
  icon,
  label,
  selected,
  type = "button",
  ...props
}: IconButtonProps): ReactNode {
  return (
    <button
      aria-label={label}
      aria-pressed={ariaPressed ?? (selected === undefined ? undefined : selected)}
      className={cn("hs-icon-button", selected && "hs-icon-button--selected", className)}
      title={label}
      type={type}
      {...props}
    >
      {icon}
    </button>
  );
}

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: StatusTone;
}

export function StatusPill({
  children,
  className,
  tone = "neutral",
  ...props
}: StatusPillProps): ReactNode {
  return (
    <span
      className={cn("hs-status-pill", `hs-status-pill--${tone}`, className)}
      {...props}
    >
      {children}
    </span>
  );
}

export interface SegmentedTabItem<TTab extends string> {
  id: TTab;
  label: string;
  count?: number;
}

export interface SegmentedTabsProps<TTab extends string> {
  tabs: Array<SegmentedTabItem<TTab>>;
  activeTab: TTab;
  onChange: (tab: TTab) => void;
  label: string;
  className?: string;
}

export function SegmentedTabs<TTab extends string>({
  activeTab,
  className,
  label,
  onChange,
  tabs
}: SegmentedTabsProps<TTab>): ReactNode {
  return (
    <div aria-label={label} className={cn("hs-segmented-tabs", className)} role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={tab.id === activeTab}
          className={cn("hs-segmented-tabs__tab", tab.id === activeTab && "is-active")}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          type="button"
        >
          <span>{tab.label}</span>
          {typeof tab.count === "number" ? <strong>{tab.count}</strong> : null}
        </button>
      ))}
    </div>
  );
}

export interface PanelHeaderProps {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
}

export function PanelHeader({
  actions,
  className,
  eyebrow,
  title,
  titleId
}: PanelHeaderProps): ReactNode {
  return (
    <header className={cn("hs-panel-header", className)}>
      <div>
        {eyebrow ? <span className="hs-panel-header__eyebrow">{eyebrow}</span> : null}
        <h2 id={titleId}>{title}</h2>
      </div>
      {actions ? <div className="hs-panel-header__actions">{actions}</div> : null}
    </header>
  );
}
