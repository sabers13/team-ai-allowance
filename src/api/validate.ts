/**
 * Boundary validation for JSON and form bodies.
 *
 * Every helper throws a typed 400 `ApiError` naming the field, so a provider
 * body or a stack trace never reaches the caller.
 */

import { badRequest } from "./errors.ts";

export type Fields = Record<string, unknown>;

export interface StringRule {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
}

export function objectBody(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return value as Fields;
}

function checkString(value: string, field: string, rule: StringRule): string {
  if (rule.minLength !== undefined && value.length < rule.minLength) {
    throw badRequest(`${field} must be at least ${rule.minLength} characters.`, { field });
  }
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    throw badRequest(`${field} must be at most ${rule.maxLength} characters.`, { field });
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    throw badRequest(rule.patternMessage ?? `${field} has an invalid format.`, { field });
  }
  return value;
}

export function requiredString(body: Fields, field: string, rule: StringRule = {}): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string.`, { field });
  }
  return checkString(value, field, rule);
}

export function optionalString(
  body: Fields,
  field: string,
  rule: StringRule = {},
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string.`, { field });
  }
  return checkString(value, field, rule);
}

export function optionalNullableString(
  body: Fields,
  field: string,
  rule: StringRule = {},
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string or null.`, { field });
  }
  return checkString(value, field, rule);
}

export interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
}

function checkNumber(value: number, field: string, rule: NumberRule): number {
  if (!Number.isFinite(value)) {
    throw badRequest(`${field} must be a finite number.`, { field });
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    throw badRequest(`${field} must be an integer.`, { field });
  }
  if (rule.min !== undefined && value < rule.min) {
    throw badRequest(`${field} must be at least ${rule.min}.`, { field });
  }
  if (rule.max !== undefined && value > rule.max) {
    throw badRequest(`${field} must be at most ${rule.max}.`, { field });
  }
  return value;
}

export function requiredNumber(body: Fields, field: string, rule: NumberRule = {}): number {
  const value = body[field];
  if (typeof value !== "number") {
    throw badRequest(`${field} must be a number.`, { field });
  }
  return checkNumber(value, field, rule);
}

export function optionalNumber(
  body: Fields,
  field: string,
  rule: NumberRule = {},
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw badRequest(`${field} must be a number.`, { field });
  }
  return checkNumber(value, field, rule);
}

export function optionalNullableNumber(
  body: Fields,
  field: string,
  rule: NumberRule = {},
): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number") {
    throw badRequest(`${field} must be a number or null.`, { field });
  }
  return checkNumber(value, field, rule);
}

export function optionalBoolean(body: Fields, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw badRequest(`${field} must be true or false.`, { field });
  }
  return value;
}

export function requiredBoolean(body: Fields, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw badRequest(`${field} must be true or false.`, { field });
  }
  return value;
}

export function enumValue<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`, { field });
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return enumValue(field, value, allowed);
}

export function stringArray(
  body: Fields,
  field: string,
  options: { maxLength?: number; maxItems?: number } = {},
): string[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array of strings.`, { field });
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw badRequest(`${field} must have at most ${options.maxItems} items.`, { field });
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw badRequest(`${field}[${index}] must be a non-empty string.`, { field });
    }
    if (options.maxLength !== undefined && item.length > options.maxLength) {
      throw badRequest(`${field}[${index}] is too long.`, { field });
    }
    return item;
  });
}

export function optionalStringArray(
  body: Fields,
  field: string,
  options: { maxLength?: number; maxItems?: number } = {},
): string[] | undefined {
  if (body[field] === undefined) return undefined;
  return stringArray(body, field, options);
}

export function isoDateTime(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${field} must be an ISO 8601 date.`, { field });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw badRequest(`${field} must be an ISO 8601 date.`, { field });
  }
  return new Date(parsed).toISOString();
}

export function optionalIsoDateTime(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return isoDateTime(field, value);
}

export function limitFromQuery(
  value: string | null,
  options: { fallback: number; min?: number; max: number },
): number {
  if (value === null || value.length === 0) return options.fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (options.min ?? 1) || parsed > options.max) {
    throw badRequest(`limit must be an integer between ${options.min ?? 1} and ${options.max}.`, {
      field: "limit",
    });
  }
  return parsed;
}
