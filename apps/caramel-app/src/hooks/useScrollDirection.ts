import { useEffect, useRef, useState } from 'react'

export function useScrollDirection(
    scrollRef?: React.RefObject<HTMLElement | HTMLDivElement | null>,
) {
    const [isScrollingUp, setIsScrollingUp] = useState(false)
    const [isScrollingDown, setIsScrollingDown] = useState(false)

    // We store the previous scroll position in a ref so it persists across renders
    const prevScrollPosRef = useRef(0)

    useEffect(() => {
        // Decide whether to observe the window or a custom scrollable element
        const target = scrollRef?.current || window

        function handleScroll() {
            // Current scroll position (for a DIV or for the window)
            const currentScrollPos = scrollRef?.current
                ? scrollRef.current.scrollTop
                : window.scrollY

            if (currentScrollPos > prevScrollPosRef.current) {
                // The user is scrolling down
                setIsScrollingDown(true)
                setIsScrollingUp(false)
            } else if (currentScrollPos < prevScrollPosRef.current) {
                // The user is scrolling up
                setIsScrollingDown(false)
                setIsScrollingUp(true)
            }

            prevScrollPosRef.current = currentScrollPos
        }

        // Attach the event
        target.addEventListener('scroll', handleScroll, { passive: true })
        // Cleanup
        return () => {
            target.removeEventListener('scroll', handleScroll)
        }
    }, [scrollRef])

    return { isScrollingUp, isScrollingDown }
}
