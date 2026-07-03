import sys
import math

def solve(boxes_a, boxes_b, boxes_c):
    list_boxes = sorted(boxes_a + boxes_b + boxes_c, reverse=True) 
    dict_boxes = {}
    all_moves = []
    
    for i, a in enumerate(boxes_a):
        dict_boxes[f"A{i}"] = a
    for i, b in enumerate(boxes_b)
        dict_boxes[f"B{i}"] = b
    for i, c in enumerate(boxes_c):
        dict_boxes[f"C{i}"] = c 
    
        

def find_next_max(lst):


    
solve([], [], [])



    # all_boxes = sorted(boxes_a + boxes_b + boxes_c, reverse=True)
    # all_stacks = {"A": boxes_a[:], "B": boxes_b[:], "C": boxes_c[:]}
    # all_moves = []

    # def move(src, dst):
    #     box = all_stacks[src].pop()
    #     all_stacks[dst].append(box)
    #     all_moves.append(f"{src} {dst}")

    # def top(name):
    #     stack = all_stacks[name]
    #     return stack[-1] if stack else None
    
    # for box in all_boxes:
    #     for name in all_stacks:
    #         if all_stacks[name] is not None and box in all_stacks[name]: