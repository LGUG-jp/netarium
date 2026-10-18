<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;

final class CanvasNote
{
    public const MAX_TEXT_LENGTH = 1000;
    public const COLUMNS = ['id', 'view_id', 'text', 'x', 'y', 'width', 'height', 'background_color', 'background_opacity', 'text_color', 'font_size'];

    public static function normalize(array $row): array
    {
        foreach (['id', 'view_id'] as $field) {
            if (!is_int($row[$field] ?? null)) {
                throw new ApiException("canvas_notes.{$field}は正の整数で指定してください", 400);
            }
            $row[$field] = ResourceId::parse($row[$field] ?? null, "canvas_notes.{$field}");
        }
        $text = array_key_exists('text', $row) ? $row['text'] : '';
        if (!is_string($text) || preg_match('//u', $text) !== 1) {
            throw new ApiException('メモ本文はUTF-8文字列で指定してください', 400);
        }
        $length = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : (int)preg_match_all('/./us', $text);
        if ($length > self::MAX_TEXT_LENGTH) {
            throw new ApiException('メモ本文は1000文字以内で入力してください', 400);
        }
        $result = ['id' => $row['id'], 'view_id' => $row['view_id'], 'text' => $text];
        foreach ([
            'x' => [0, PHP_FLOAT_MAX, 0], 'y' => [0, PHP_FLOAT_MAX, 0],
            'width' => [120, 2000, 220], 'height' => [60, 2000, 120],
            'background_opacity' => [0.2, 1, 0.85], 'font_size' => [12, 32, 14],
        ] as $field => [$min, $max, $default]) {
            $value = array_key_exists($field, $row) ? $row[$field] : $default;
            if ((!is_int($value) && !is_float($value)) || !is_finite((float)$value) || $value < $min || $value > $max) {
                throw new ApiException("canvas_notes.{$field}は{$min}〜{$max}の有限数で指定してください", 400);
            }
            $result[$field] = (float)$value;
        }
        foreach (['background_color' => '#FFF3B0', 'text_color' => '#263238'] as $field => $default) {
            $value = array_key_exists($field, $row) ? $row[$field] : $default;
            if (!is_string($value) || preg_match('/\A#[0-9A-Fa-f]{6}\z/', $value) !== 1) {
                throw new ApiException("canvas_notes.{$field}は#RRGGBB形式で指定してください", 400);
            }
            $result[$field] = strtoupper($value);
        }
        return $result;
    }

    public static function normalizeRows(mixed $rows, array $viewIds): array
    {
        if (!is_array($rows) || !array_is_list($rows)) {
            throw new ApiException('canvas_notesは配列で指定してください', 400);
        }
        $result = [];
        $seen = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                throw new ApiException('canvas_notesの行形式が不正です', 400);
            }
            $note = self::normalize($row);
            if (isset($seen[$note['id']])) {
                throw new ApiException('メモIDが重複しています', 400);
            }
            if (!isset($viewIds[$note['view_id']])) {
                throw new ApiException('メモが存在しないビューを参照しています', 400);
            }
            $seen[$note['id']] = true;
            $result[] = $note;
        }
        return $result;
    }
}
