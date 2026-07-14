import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode } from "react";

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
  idPrefix?: string;
  panelId?: string;
}

export function SegmentedTabs<TTab extends string>({
  activeTab,
  className,
  label,
  onChange,
  tabs,
  idPrefix = "hs-tabs-tab",
  panelId
}: SegmentedTabsProps<TTab>): ReactNode {
  const tabId = (tabIdValue: TTab): string =>
    `${idPrefix}-${String(tabIdValue).replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const key = event.key;
    const nextIndex = key === "ArrowRight" || key === "ArrowDown"
      ? (index + 1) % tabs.length
      : key === "ArrowLeft" || key === "ArrowUp"
        ? (index - 1 + tabs.length) % tabs.length
        : key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : undefined;

    if (nextIndex === undefined || tabs.length === 0) {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) {
      return;
    }
    onChange(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(tabId(nextTab.id))?.focus());
  };

  return (
    <div aria-label={label} aria-orientation="horizontal" className={cn("hs-segmented-tabs", className)} role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <button
            aria-controls={panelId}
            aria-selected={selected}
            className={cn("hs-segmented-tabs__tab", selected && "is-active")}
            id={tabId(tab.id)}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, tabs.indexOf(tab))}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            <span>{tab.label}</span>
            {typeof tab.count === "number" ? <strong>{tab.count}</strong> : null}
          </button>
        );
      })}
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
