import {
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from 'react';
import { cx, focusRing } from './utils';

type Tone = 'default' | 'muted' | 'primary' | 'success' | 'warning' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const textTones: Record<Tone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export interface TextProps extends HTMLAttributes<HTMLParagraphElement> {
  as?: 'p' | 'span' | 'div';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  tone?: Tone;
}

export function Text({
  as: Component = 'p',
  size = 'md',
  tone = 'default',
  className,
  ...props
}: TextProps) {
  return (
    <Component
      className={cx(
        'font-sans',
        { xs: 'text-xs', sm: 'text-sm', md: 'text-base', lg: 'text-lg' }[size],
        textTones[tone],
        className,
      )}
      {...props}
    />
  );
}

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Heading({ as: Component = 'h2', size = 'md', className, ...props }: HeadingProps) {
  return (
    <Component
      className={cx(
        'font-sans font-bold tracking-tight text-foreground',
        { sm: 'text-lg', md: 'text-xl', lg: 'text-2xl', xl: 'text-3xl' }[size],
        className,
      )}
      {...props}
    />
  );
}

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor: string;
}
export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, htmlFor, ...props }, ref) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is required by LabelProps and forwarded below.
    <label
      ref={ref}
      htmlFor={htmlFor}
      className={cx('font-sans text-sm font-medium text-foreground', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:brightness-110 active:brightness-90',
  secondary:
    'border border-border bg-surface text-foreground hover:bg-muted active:bg-surface-raised',
  ghost: 'text-foreground hover:bg-muted active:bg-surface-raised',
  danger: 'bg-danger text-danger-foreground hover:brightness-110 active:brightness-90',
};
const buttonSizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  isLoading?: boolean;
  loadingText?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      loadingText,
      disabled,
      className,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50',
        focusRing,
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {isLoading && <Spinner size="sm" aria-label="Loading" />}
      {isLoading && loadingText ? loadingText : children}
    </button>
  ),
);
Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  'aria-label': string;
  children: ReactNode;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', className, ...props }, ref) => (
    <Button
      ref={ref}
      size={size}
      className={cx('aspect-square px-0', { sm: 'w-8', md: 'w-10', lg: 'w-12' }[size], className)}
      {...props}
    />
  ),
);
IconButton.displayName = 'IconButton';

export type LoadingButtonProps = Omit<ButtonProps, 'isLoading'> & { loading?: boolean };
export const LoadingButton = forwardRef<HTMLButtonElement, LoadingButtonProps>(
  ({ loading = false, ...props }, ref) => <Button ref={ref} isLoading={loading} {...props} />,
);
LoadingButton.displayName = 'LoadingButton';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ invalid = false, className, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-10 w-full rounded-md border border-border bg-surface px-3 font-sans text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-fast hover:border-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        invalid && 'border-danger focus-visible:ring-danger',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export interface SearchInputProps extends Omit<InputProps, 'type'> {
  onClear?: () => void;
  clearLabel?: string;
  shortcut?: string;
}
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, onClear, clearLabel = 'Clear search', shortcut, ...props }, ref) => (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground"
      >
        ⌕
      </span>
      <Input
        ref={ref}
        type="search"
        className={cx('pl-9', (onClear || shortcut) && 'pr-10', className)}
        {...props}
      />
      {onClear && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={onClear}
          className={cx(
            'absolute inset-y-0 right-1 my-auto h-8 w-8 rounded text-muted-foreground hover:bg-muted hover:text-foreground',
            focusRing,
          )}
        >
          ×
        </button>
      )}
      {shortcut && !onClear && (
        <kbd className="pointer-events-none absolute inset-y-0 right-3 my-auto flex h-5 items-center rounded border border-border px-1 font-sans text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ invalid = false, className, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-fast hover:border-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        invalid && 'border-danger focus-visible:ring-danger',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ id, label, className, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    return (
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cx('h-4 w-4 rounded border-border accent-primary', focusRing, className)}
          {...props}
        />
        {label && <Label htmlFor={inputId}>{label}</Label>}
      </div>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}
export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ id, label, className, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    return (
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={inputId}
          type="radio"
          className={cx('h-4 w-4 border-border accent-primary', focusRing, className)}
          {...props}
        />
        {label && <Label htmlFor={inputId}>{label}</Label>}
      </div>
    );
  },
);
Radio.displayName = 'Radio';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
}
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  disabled,
  className,
  ...props
}: SwitchProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = useState(defaultChecked);
  const isChecked = checked ?? uncontrolledChecked;
  const toggle = () => {
    if (checked === undefined) setUncontrolledChecked(!isChecked);
    onCheckedChange?.(!isChecked);
  };
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={isChecked}
        disabled={disabled}
        onClick={toggle}
        className={cx(
          'relative h-6 w-11 rounded-full bg-muted transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50',
          isChecked && 'bg-primary',
          focusRing,
          className,
        )}
        {...props}
      >
        <span
          className={cx(
            'absolute top-1 h-4 w-4 rounded-full bg-primary-foreground transition-transform duration-fast',
            isChecked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      {label && <span className="font-sans text-sm text-foreground">{label}</span>}
    </div>
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
}
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ elevated = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx(
        'rounded-lg border border-border bg-surface p-4 text-foreground',
        elevated && 'shadow-md',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export interface AvatarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  src?: string | undefined;
  alt?: string;
  name?: string;
  size?: Size | 'xl';
}
export function Avatar({ src, alt = '', name, size = 'md', className, ...props }: AvatarProps) {
  const initials =
    name
      ?.trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() ?? '?';
  return (
    <div
      role="img"
      aria-label={alt || name || 'Avatar'}
      className={cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground',
        {
          sm: 'h-8 w-8 text-xs',
          md: 'h-10 w-10 text-sm',
          lg: 'h-12 w-12 text-base',
          xl: 'h-20 w-20 text-xl',
        }[size],
        className,
      )}
      {...props}
    >
      {src ? <img src={src} alt={alt} className="h-full w-full object-cover" /> : initials}
    </div>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Exclude<Tone, 'default'>;
}
export function Badge({ tone = 'primary', className, ...props }: BadgeProps) {
  const tones: Record<Exclude<Tone, 'default'>, string> = {
    primary: 'bg-primary text-primary-foreground',
    success: 'bg-success text-success-foreground',
    warning: 'bg-warning text-warning-foreground',
    danger: 'bg-danger text-danger-foreground',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  onRemove?: () => void;
  removeLabel?: string;
}
export function Tag({
  onRemove,
  removeLabel = 'Remove tag',
  className,
  children,
  ...props
}: TagProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-sans text-sm text-foreground',
        className,
      )}
      {...props}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className={cx('rounded text-muted-foreground hover:text-foreground', focusRing)}
        >
          ×
        </button>
      )}
    </span>
  );
}

export type DividerProps = HTMLAttributes<HTMLHRElement>;
export const Divider = forwardRef<HTMLHRElement, DividerProps>(({ className, ...props }, ref) => (
  <hr ref={ref} className={cx('border-0 border-t border-border', className)} {...props} />
));
Divider.displayName = 'Divider';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: Size;
}
export function Spinner({ size = 'md', className, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      className={cx(
        'inline-block animate-spin rounded-full border-2 border-current border-r-transparent',
        { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size],
        className,
      )}
      {...props}
    >
      <span className="sr-only">Loading</span>
    </span>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  circle?: boolean;
}
export function Skeleton({ circle = false, className, ...props }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading content"
      className={cx('animate-pulse rounded-md bg-muted', circle && 'rounded-full', className)}
      {...props}
    />
  );
}

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  label?: string;
}

export function Progress({
  value,
  max = 100,
  label = 'Progress',
  className,
  ...props
}: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = (clamped / safeMax) * 100;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeMax)}
      aria-label={label}
      className={cx('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-fast"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ invalid = false, className, children, ...props }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-10 w-full rounded-md border border-border bg-surface px-3 font-sans text-sm text-foreground transition-colors duration-fast hover:border-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        invalid && 'border-danger focus-visible:ring-danger',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
