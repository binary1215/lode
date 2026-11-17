# DLG-01 내보내기 확인 (모달)

## 이 화면이 무엇인가

| 항목 | 내용 |
|---|---|
| ID | DLG-01 |
| 이름 | 내보내기 확인 |
| 그리는 코드 | `station/ui/main_window.py#ExportDialog` |
| 추정 | 코드만 보고 쓴 추정 |

## 개요

내보내기 전에 확인을 받는 모달이다.

## 화면 흐름

확인을 누르면 닫힌다.

## 화면요소

| ID | 한 줄 | 위치 | 조작하면 실행되는 기능 | 보여 주는 기능 |
|---|---|---|---|---|
| DLG-01#1 | 확인 버튼 | `station/ui/main_window.py:57` | `fe/station/ui/main_window/ExportDialog@clicked:accept` | |

## 화면 정책

없음.
