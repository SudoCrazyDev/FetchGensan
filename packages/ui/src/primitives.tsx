/**
 * The small set of primitives both mobile apps are built from.
 *
 * Kept intentionally plain -- no animation library, no styling DSL. Two
 * apps and one designer's worth of surface area does not justify either,
 * and every dependency here is one more thing that can break a release on
 * a two-year-old Android.
 */

import { type ReactNode, forwardRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { formatPeso } from '@fetch/core';
import { MIN_TOUCH } from './theme';
import { useTheme } from './ThemeProvider';

// ---------------------------------------------------------------- layout

export function Screen({
  children,
  style,
  edges = ['top', 'bottom'],
  scroll = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  edges?: readonly Edge[];
  scroll?: boolean;
}) {
  const t = useTheme();
  const body = (
    <View style={[{ flex: 1, padding: t.space(4) }, style]}>{children}</View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.color.background }} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

export function Stack({
  children,
  gap = 3,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return <View style={[{ gap: t.space(gap) }, style]}>{children}</View>;
}

export function Row({
  children,
  gap = 2,
  align = 'center',
  justify = 'flex-start',
  style,
}: {
  children: ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: align, justifyContent: justify, gap: t.space(gap) },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Spacer({ size = 3 }: { size?: number }) {
  const t = useTheme();
  return <View style={{ height: t.space(size) }} />;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.color.border }} />;
}

// ---------------------------------------------------------------- text

type TextTone = 'default' | 'muted' | 'primary' | 'danger' | 'success' | 'inverse';

function toneColor(tone: TextTone, t: ReturnType<typeof useTheme>): string {
  switch (tone) {
    case 'muted':
      return t.color.textMuted;
    case 'primary':
      return t.color.primary;
    case 'danger':
      return t.color.danger;
    case 'success':
      return t.color.success;
    case 'inverse':
      return t.color.textInverse;
    default:
      return t.color.text;
  }
}

export interface TxtProps {
  children: ReactNode;
  size?: 'caption' | 'small' | 'body' | 'title' | 'heading' | 'display';
  weight?: '400' | '500' | '600' | '700';
  tone?: TextTone;
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  /** Announce changes to screen readers -- for errors that appear after a tap. */
  live?: boolean;
}

export function Txt({
  children,
  size = 'body',
  weight = '400',
  tone = 'default',
  align,
  numberOfLines,
  style,
  live = false,
}: TxtProps) {
  const t = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      accessibilityLiveRegion={live ? 'polite' : undefined}
      role={live ? 'alert' : undefined}
      style={[
        {
          fontSize: t.font[size],
          fontWeight: weight,
          color: toneColor(tone, t),
          textAlign: align,
        },
        style,
      ]}
      // Respect the OS font size, but stop a 200% setting from destroying
      // the layout of a screen someone needs to use in a hurry.
      maxFontSizeMultiplier={1.4}
    >
      {children}
    </Text>
  );
}

/** A money amount. Always goes through formatPeso so it cannot drift. */
export function Money({
  centavos,
  size = 'body',
  weight = '600',
  tone = 'default',
  decimals,
}: {
  centavos: number;
  size?: TxtProps['size'];
  weight?: TxtProps['weight'];
  tone?: TextTone;
  decimals?: boolean;
}) {
  return (
    <Txt size={size} weight={weight} tone={tone}>
      {formatPeso(centavos, decimals === undefined ? undefined : { decimals })}
    </Txt>
  );
}

// ---------------------------------------------------------------- surfaces

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const t = useTheme();
  const surface: ViewStyle = {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    padding: t.space(4),
  };

  if (!onPress) return <View style={[surface, style]}>{children}</View>;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [surface, pressed && { opacity: 0.7 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'progress' | 'success' | 'danger' | 'attention';
}) {
  const t = useTheme();

  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: t.color.border, fg: t.color.textMuted },
    progress: { bg: t.color.infoSoft, fg: t.color.info },
    success: { bg: t.color.successSoft, fg: t.color.success },
    danger: { bg: t.color.dangerSoft, fg: t.color.danger },
    attention: { bg: t.dark ? 'rgba(249,138,21,0.18)' : '#FFEFD4', fg: t.color.primary },
  };
  const c = tones[tone] ?? tones.neutral!;

  return (
    <View
      style={{
        backgroundColor: c.bg,
        paddingHorizontal: t.space(2.5),
        paddingVertical: t.space(1),
        borderRadius: t.radius.pill,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ color: c.fg, fontSize: t.font.caption, fontWeight: '700' }}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------- controls

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  style,
  ...rest
}: ButtonProps) {
  const t = useTheme();
  const isDisabled = disabled || loading;

  const height = size === 'lg' ? 56 : MIN_TOUCH;

  const variants: Record<string, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.color.primary, fg: t.color.onPrimary, border: 'transparent' },
    secondary: { bg: t.color.surfaceRaised, fg: t.color.text, border: t.color.border },
    ghost: { bg: 'transparent', fg: t.color.primary, border: 'transparent' },
    danger: { bg: t.color.dangerSoft, fg: t.color.danger, border: 'transparent' },
  };
  const v = variants[variant] ?? variants.primary!;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          height,
          borderRadius: t.radius.md,
          backgroundColor: v.bg,
          borderWidth: v.border === 'transparent' ? 0 : StyleSheet.hairlineWidth,
          borderColor: v.border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: t.space(2),
          paddingHorizontal: t.space(4),
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <>
          {icon}
          <Text
            style={{
              color: v.fg,
              fontSize: size === 'lg' ? t.font.title : t.font.body,
              fontWeight: '700',
            }}
            maxFontSizeMultiplier={1.3}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export interface FieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string;
}

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, error, hint, style, ...rest },
  ref,
) {
  const t = useTheme();

  return (
    <View style={{ gap: t.space(1.5) }}>
      {label ? (
        <Txt size="small" weight="600" tone="muted">
          {label}
        </Txt>
      ) : null}
      <TextInput
        ref={ref}
        placeholderTextColor={t.color.textMuted}
        style={[
          {
            minHeight: MIN_TOUCH,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: error ? t.color.danger : t.color.border,
            backgroundColor: t.color.surface,
            borderRadius: t.radius.md,
            paddingHorizontal: t.space(3.5),
            paddingVertical: t.space(3),
            fontSize: t.font.body,
            color: t.color.text,
          },
          style,
        ]}
        {...rest}
      />
      {error ? (
        <Txt size="small" tone="danger">
          {error}
        </Txt>
      ) : hint ? (
        <Txt size="small" tone="muted">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
});

export interface PasswordFieldProps extends Omit<TextInputProps, 'secureTextEntry'> {
  label?: string;
  error?: string | null;
  hint?: string;
}

/**
 * A password input with a Show/Hide toggle. On a phone keyboard, in the
 * sun, with a thumb, typing blind is how people lock themselves out; being
 * able to check what they typed matters more here than on a desktop.
 */
export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(function PasswordField(
  { label, error, hint, style, ...rest },
  ref,
) {
  const t = useTheme();
  const [visible, setVisible] = useState(false);

  return (
    <View style={{ gap: t.space(1.5) }}>
      {label ? (
        <Txt size="small" weight="600" tone="muted">
          {label}
        </Txt>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: MIN_TOUCH,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: error ? t.color.danger : t.color.border,
          backgroundColor: t.color.surface,
          borderRadius: t.radius.md,
        }}
      >
        <TextInput
          ref={ref}
          placeholderTextColor={t.color.textMuted}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            {
              flex: 1,
              paddingHorizontal: t.space(3.5),
              paddingVertical: t.space(3),
              fontSize: t.font.body,
              color: t.color.text,
            },
            style,
          ]}
          {...rest}
        />
        <Pressable
          onPress={() => setVisible((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Hide password' : 'Show password'}
          hitSlop={8}
          style={{
            minHeight: MIN_TOUCH,
            justifyContent: 'center',
            paddingHorizontal: t.space(3.5),
          }}
        >
          <Txt size="small" weight="700" tone="primary">
            {visible ? 'Hide' : 'Show'}
          </Txt>
        </Pressable>
      </View>
      {error ? (
        <Txt size="small" tone="danger">
          {error}
        </Txt>
      ) : hint ? (
        <Txt size="small" tone="muted">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
});

/** Full-screen loading state, for the gap before the session is known. */
export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.space(3),
        backgroundColor: t.color.background,
      }}
    >
      <ActivityIndicator size="large" color={t.color.primary} />
      {label ? (
        <Txt tone="muted" size="small">
          {label}
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * Empty and error states. Both take an action, because a dead end with no
 * way forward is the worst thing to hand someone who is standing on a
 * street corner waiting for a ride.
 */
export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: t.space(2), padding: t.space(6) }}>
      <Txt size="title" weight="600" align="center">
        {title}
      </Txt>
      {body ? (
        <Txt tone="muted" align="center">
          {body}
        </Txt>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} style={{ marginTop: t.space(2) }} />
      ) : null}
    </View>
  );
}
